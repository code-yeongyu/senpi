import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { JsonAgentSessionEvent } from "../json-event.ts";
import { attachJsonlLineReader, MAX_RPC_LINE_CHARACTERS, serializeJsonLine } from "../rpc/jsonl.ts";
import { connectRpcClientSocket } from "../rpc/rpc-client-socket.ts";
import { requestDeadlineMs } from "../rpc/rpc-request-deadline.ts";
import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcQuestionResolvedEvent,
	RpcQuestionUpdatedEvent,
	RpcResponse,
	RpcSessionStatusEvent,
} from "../rpc/rpc-types.ts";

export type AttachRecord = (
	| Exclude<JsonAgentSessionEvent, { type: "message_update" }>
	| (Extract<JsonAgentSessionEvent, { type: "message_update" }> & { readonly message?: AssistantMessage | null })
	| RpcExtensionUIRequest
	| RpcSessionStatusEvent
	| RpcQuestionResolvedEvent
	| RpcQuestionUpdatedEvent
) & { readonly sessionId?: string; readonly entryId?: string };
type Answer = Extract<RpcResponse, { success: true }>;

/** The endpoint refused an attachment the presentation asked for; `code` is machine-readable. */
export class AttachRefusedError extends Error {
	readonly code: "session_not_retained";
	constructor(code: "session_not_retained", message: string) {
		super(message);
		this.name = "AttachRefusedError";
		this.code = code;
	}
}

/** The endpoint answered a dialog response with a refusal; `code` is the endpoint's error. */
export class AnswerRefusedError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(`Answer refused: ${code}`);
		this.name = "AnswerRefusedError";
		this.code = code;
	}
}

const ANSWER_DEADLINE_MS = 30_000;

/** A presentation-only socket client: it cannot spawn or fall back to an in-process runtime. */
export class AttachClient {
	private socket: Socket | undefined;
	private stopReading: (() => void) | undefined;
	private readonly pending = new Map<string, { resolve: (answer: Answer) => void; reject: (error: Error) => void }>();
	private closed = false;
	private failure: string | undefined;
	private readonly onRecord: (record: AttachRecord) => void;
	private readonly onDisconnect: (reason?: string) => void;
	private readonly answerDeadlineMs: number;

	constructor(
		onRecord: (record: AttachRecord) => void,
		onDisconnect: (reason?: string) => void,
		options: { readonly answerDeadlineMs?: number } = {},
	) {
		this.onRecord = onRecord;
		this.onDisconnect = onDisconnect;
		this.answerDeadlineMs = options.answerDeadlineMs ?? ANSWER_DEADLINE_MS;
	}

	async connect(path: string): Promise<void> {
		const socket = await connectRpcClientSocket(path, {});
		if (this.closed) {
			socket.destroy();
			throw new Error("Disconnected");
		}
		this.socket = socket;
		this.stopReading = attachJsonlLineReader(socket, (line) => this.receive(socket, line), {
			maxLineLength: MAX_RPC_LINE_CHARACTERS,
			onOversizedLine: () => this.fail(socket, "the endpoint sent a record over the line limit"),
		});
		socket.once("error", () => socket.destroy());
		socket.once("close", () => {
			this.socket = undefined;
			this.rejectPending();
			if (!this.closed) this.onDisconnect(this.failure);
		});
	}

	request(command: RpcCommand & { readonly observe?: boolean }): Promise<Answer> {
		const id = randomUUID();
		return this.track(
			id,
			requestDeadlineMs(command),
			`No acknowledgement for ${command.type}; its outcome is unknown`,
			{
				...command,
				id,
			},
		);
	}

	/** Sends a dialog answer and settles when the endpoint accepts it; a refusal rejects with its code. */
	async answer(sessionId: string, response: RpcExtensionUIResponse): Promise<void> {
		await this.track(response.id, this.answerDeadlineMs, "No acknowledgement for the answer", {
			...response,
			sessionId,
			answerId: randomUUID(),
		});
	}

	close(): void {
		this.closed = true;
		this.stopReading?.();
		this.socket?.destroy();
		this.socket = undefined;
		this.rejectPending();
	}

	private track(id: string, deadlineMs: number, unanswered: string, record: object): Promise<Answer> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(unanswered));
			}, deadlineMs);
			this.pending.set(id, {
				resolve: (answer) => {
					clearTimeout(timer);
					resolve(answer);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			if (this.socket?.writable && !this.socket.destroyed) {
				this.socket.write(serializeJsonLine(record));
				return;
			}
			clearTimeout(timer);
			this.pending.delete(id);
			reject(new Error("Disconnected"));
		});
	}

	/** One endpoint line. A record it cannot read or render ends the connection; it never throws to the socket. */
	private receive(socket: Socket, line: string): void {
		let record: RpcResponse | AttachRecord;
		try {
			record = JSON.parse(line);
		} catch {
			this.fail(socket, "the endpoint sent an unreadable record");
			return;
		}
		if (record.type === "response") {
			const pending = record.id ? this.pending.get(record.id) : undefined;
			if (!pending) return;
			if (record.id) this.pending.delete(record.id);
			if (record.success) pending.resolve(record);
			else if (record.command === "extension_ui_response") pending.reject(new AnswerRefusedError(record.error));
			else pending.reject(new Error(record.error));
			return;
		}
		try {
			this.onRecord(record);
		} catch (error) {
			this.fail(
				socket,
				`a ${record.type} record could not be shown (${error instanceof Error ? error.message : String(error)})`,
			);
		}
	}

	private fail(socket: Socket, reason: string): void {
		this.failure ??= reason;
		socket.destroy();
	}

	private rejectPending(): void {
		for (const request of this.pending.values())
			request.reject(new Error("Disconnected; pending command outcome is unknown"));
		this.pending.clear();
	}
}
