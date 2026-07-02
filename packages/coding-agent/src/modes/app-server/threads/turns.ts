import * as crypto from "node:crypto";
// allow: SIZE_OK - Todo 9's write scope requires the complete turn engine in this single module.
import type {
	JsonValue,
	ThreadId,
	Turn,
	TurnInterruptParams,
	TurnInterruptResponse,
	TurnStartParams,
	TurnStartResponse,
	TurnSteerParams,
	TurnSteerResponse,
	UserInput,
} from "../protocol/index.ts";
import type { JsonRpcError } from "../rpc/errors.ts";
import type { ActiveTurn } from "./registry.ts";
import type { TurnLog, WireItem } from "./turn-log.ts";

type TurnWireStatus = "inProgress" | "completed" | "failed" | "interrupted";
type LoggedStartStatus = "running";

export type TurnEngineSessionEvent = { readonly type: string; readonly [key: string]: unknown };

export interface TurnEngineSession {
	prompt(
		text: string,
		options?: { readonly source?: "rpc"; readonly preflightResult?: (success: boolean) => void },
	): Promise<void>;
	steer(text: string): Promise<void>;
	abort(): Promise<void>;
	subscribe(listener: (event: TurnEngineSessionEvent) => void): () => void;
}

export type TurnEngineThreadStatus = "idle" | "active";

export interface TurnEngineThreadEntry {
	readonly id: string;
	readonly session: TurnEngineSession;
	activeTurn: ActiveTurn | null;
	status: TurnEngineThreadStatus;
	updatedAt: string;
}

export interface TurnEngineStore<Entry extends TurnEngineThreadEntry = TurnEngineThreadEntry> {
	getLoadedThread(threadId: string): Entry;
	runThreadTask<T>(threadId: string, task: () => Promise<T> | T): Promise<T>;
}

export interface TurnEngineNotification {
	readonly method: string;
	readonly params?: JsonValue;
}

export interface TurnEngineOptions<Entry extends TurnEngineThreadEntry = TurnEngineThreadEntry> {
	readonly store: TurnEngineStore<Entry>;
	readonly turnLog: TurnLog;
	readonly emitToThread: (threadId: string, notification: TurnEngineNotification) => void;
	readonly broadcast: (notification: TurnEngineNotification) => void;
}

export class TurnEngineError extends Error {
	readonly error: JsonRpcError;

	constructor(error: JsonRpcError) {
		super(error.message);
		this.name = "TurnEngineError";
		this.error = error;
	}
}

type PendingTurn = {
	readonly threadId: ThreadId;
	readonly turnId: string;
	readonly startedAt: string;
	readonly startedAtMs: number;
	readonly resolve: () => void;
	interrupted: boolean;
	completed: boolean;
};

type ParsedInput = {
	readonly text: string;
	readonly content: readonly UserInput[];
};

export function createTurnEngine<Entry extends TurnEngineThreadEntry = TurnEngineThreadEntry>(
	options: TurnEngineOptions<Entry>,
): {
	readonly startTurn: (params: TurnStartParams) => Promise<TurnStartResponse>;
	readonly steerTurn: (params: TurnSteerParams) => Promise<TurnSteerResponse>;
	readonly interruptTurn: (params: TurnInterruptParams) => Promise<TurnInterruptResponse>;
	readonly completeTurn: (
		threadId: ThreadId,
		status?: Exclude<TurnWireStatus, "inProgress">,
		message?: string,
	) => void;
} {
	return new TurnEngine(options);
}

class TurnEngine<Entry extends TurnEngineThreadEntry> {
	private readonly store: TurnEngineStore<Entry>;
	private readonly turnLog: TurnLog;
	private readonly emitToThread: (threadId: string, notification: TurnEngineNotification) => void;
	private readonly broadcast: (notification: TurnEngineNotification) => void;
	private readonly pendingByThreadId = new Map<ThreadId, PendingTurn>();
	private readonly subscribedThreadIds = new Set<ThreadId>();

	constructor(options: TurnEngineOptions<Entry>) {
		this.store = options.store;
		this.turnLog = options.turnLog;
		this.emitToThread = options.emitToThread;
		this.broadcast = options.broadcast;
	}

	startTurn(params: TurnStartParams): Promise<TurnStartResponse> {
		this.getLoadedThreadOrThrow(params.threadId);

		let didSettle = false;
		const accepted = new Promise<TurnStartResponse>((resolve, reject) => {
			const run = this.store.runThreadTask(params.threadId, async () => {
				try {
					const parsedInput = parseInput(params.input);
					const entry = this.getLoadedThreadOrThrow(params.threadId);
					this.ensureSessionSubscription(params.threadId, entry);
					const turnId = crypto.randomUUID();
					const startedAtMs = Date.now();
					const startedAt = new Date(startedAtMs).toISOString();
					const turn = buildTurn(turnId, "inProgress", startedAtMs, null, []);
					const userMessage = buildUserMessage(params.clientUserMessageId ?? null, parsedInput.content);

					entry.activeTurn = { turnId, startedAt };
					entry.status = "active";
					entry.updatedAt = startedAt;
					this.turnLog.recordTurn(params.threadId, {
						turnId,
						startedAt,
						status: "running" satisfies LoggedStartStatus,
					});
					this.emitToThread(params.threadId, {
						method: "turn/started",
						params: { threadId: params.threadId, turn },
					});
					this.emitUserMessage(params.threadId, turnId, startedAtMs, userMessage);

					const completion = new Promise<void>((complete) => {
						this.pendingByThreadId.set(params.threadId, {
							threadId: params.threadId,
							turnId,
							startedAt,
							startedAtMs,
							resolve: complete,
							interrupted: false,
							completed: false,
						});
					});

					didSettle = true;
					resolve({ turn });

					void entry.session
						.prompt(parsedInput.text, {
							source: "rpc",
							preflightResult: (success) => {
								if (!success) {
									this.completeTurn(params.threadId, "failed", "Prompt preflight failed");
								}
							},
						})
						.catch((error: unknown) => {
							this.completeTurn(
								params.threadId,
								"failed",
								error instanceof Error ? error.message : String(error),
							);
						});
					await completion;
				} catch (error) {
					if (!didSettle) {
						didSettle = true;
						reject(toTurnEngineError(error));
					}
				}
			});
			run.catch((error: unknown) => {
				if (!didSettle) {
					didSettle = true;
					reject(toTurnEngineError(error));
				}
			});
		});

		return accepted;
	}

	async steerTurn(params: TurnSteerParams): Promise<TurnSteerResponse> {
		const entry = this.getLoadedThreadOrThrow(params.threadId);
		const activeTurn = entry.activeTurn;
		if (!activeTurn) {
			throw invalidRequest(`No active turn for thread ${params.threadId}`);
		}
		if (activeTurn.turnId !== params.expectedTurnId) {
			throw invalidRequest(
				`Turn id mismatch: expected ${params.expectedTurnId} but active turn is ${activeTurn.turnId}`,
			);
		}
		const parsedInput = parseInput(params.input);
		await entry.session.steer(parsedInput.text);
		return { turnId: activeTurn.turnId };
	}

	async interruptTurn(params: TurnInterruptParams): Promise<TurnInterruptResponse> {
		const entry = this.getLoadedThreadOrThrow(params.threadId);
		const activeTurn = entry.activeTurn;
		if (!activeTurn) {
			return {};
		}
		if (activeTurn.turnId !== params.turnId) {
			throw invalidRequest(`Turn id mismatch: expected ${params.turnId} but active turn is ${activeTurn.turnId}`);
		}
		const pending = this.pendingByThreadId.get(params.threadId);
		if (pending?.turnId === params.turnId) {
			pending.interrupted = true;
		}
		await entry.session.abort();
		if (entry.activeTurn?.turnId === params.turnId) {
			this.completeTurn(params.threadId, "interrupted");
		}
		return {};
	}

	completeTurn(
		threadId: ThreadId,
		status: Exclude<TurnWireStatus, "inProgress"> = "completed",
		message?: string,
	): void {
		const entry = this.getLoadedThreadOrThrow(threadId);
		const activeTurn = entry.activeTurn;
		const pending = this.pendingByThreadId.get(threadId);
		if (!activeTurn || !pending || pending.completed || pending.turnId !== activeTurn.turnId) {
			return;
		}

		pending.completed = true;
		const completedStatus = pending.interrupted && status === "completed" ? "interrupted" : status;
		const completedAtMs = Date.now();
		const turn = buildTurn(
			pending.turnId,
			completedStatus,
			pending.startedAtMs,
			completedAtMs,
			this.readLoggedItems(threadId, pending.turnId),
			message,
		);

		entry.activeTurn = null;
		entry.status = "idle";
		entry.updatedAt = new Date(completedAtMs).toISOString();
		this.pendingByThreadId.delete(threadId);
		this.emitToThread(threadId, { method: "turn/completed", params: { threadId, turn } });
		this.broadcast({ method: "thread/status/changed", params: { threadId, status: { type: "idle" } } });
		pending.resolve();
	}

	private emitUserMessage(threadId: ThreadId, turnId: string, startedAtMs: number, userMessage: WireItem): void {
		const wireUserMessage = wireItemToJson(userMessage);
		this.emitToThread(threadId, {
			method: "item/started",
			params: { threadId, turnId, item: wireUserMessage, startedAtMs },
		});
		this.emitToThread(threadId, {
			method: "item/completed",
			params: { threadId, turnId, item: wireUserMessage, completedAtMs: startedAtMs },
		});
		this.turnLog.appendItem(threadId, turnId, userMessage);
	}

	private ensureSessionSubscription(threadId: ThreadId, entry: Entry): void {
		if (this.subscribedThreadIds.has(threadId)) {
			return;
		}
		this.subscribedThreadIds.add(threadId);
		entry.session.subscribe((event) => {
			if (event.type === "agent_end") {
				this.completeTurn(threadId);
			}
		});
	}

	private readLoggedItems(threadId: ThreadId, turnId: string): readonly JsonValue[] {
		return (
			this.turnLog
				.readTurns(threadId)
				.find((turn) => turn.turnId === turnId)
				?.items.map((item) => wireItemToJson(item)) ?? []
		);
	}

	private getLoadedThreadOrThrow(threadId: ThreadId): Entry {
		try {
			return this.store.getLoadedThread(threadId);
		} catch {
			throw invalidRequest(`Thread not found: ${threadId}`);
		}
	}
}

function parseInput(input: readonly UserInput[]): ParsedInput {
	if (input.length === 0) {
		throw invalidParams("Invalid params: input must include at least one text item");
	}

	const content: UserInput[] = [];
	const textParts: string[] = [];
	for (const item of input) {
		switch (item.type) {
			case "text": {
				if (item.text.trim().length === 0) {
					throw invalidParams("Invalid params: text input must not be empty");
				}
				const textItem = {
					type: "text",
					text: item.text,
					text_elements: item.text_elements ?? [],
				} satisfies UserInput;
				content.push(textItem);
				textParts.push(item.text);
				break;
			}
			case "image":
			case "localImage":
			case "skill":
			case "mention":
				throw invalidParams(`Invalid params: unsupported input item type ${item.type}`);
			default:
				throw invalidParams("Invalid params: unknown input item type");
		}
	}

	if (textParts.length === 0) {
		throw invalidParams("Invalid params: text input is required");
	}
	return { text: textParts.join("\n"), content };
}

function buildTurn(
	turnId: string,
	status: TurnWireStatus,
	startedAtMs: number,
	completedAtMs: number | null,
	items: readonly JsonValue[],
	message?: string,
): Turn {
	return {
		id: turnId,
		items,
		itemsView: "full",
		status,
		error:
			status === "failed"
				? {
						message: message ?? "Turn failed",
						codexErrorInfo: "other",
						additionalDetails: null,
					}
				: null,
		startedAt: startedAtMs / 1000,
		completedAt: completedAtMs === null ? null : completedAtMs / 1000,
		durationMs: completedAtMs === null ? null : completedAtMs - startedAtMs,
	};
}

function buildUserMessage(clientUserMessageId: string | null, content: readonly UserInput[]): WireItem {
	return {
		type: "userMessage",
		id: clientUserMessageId ?? crypto.randomUUID(),
		clientId: clientUserMessageId,
		content: [...content],
	};
}

function wireItemToJson(item: WireItem): JsonValue {
	const jsonItem: { [key: string]: JsonValue | undefined } = {};
	for (const [key, value] of Object.entries(item)) {
		jsonItem[key] = unknownToJsonValue(value);
	}
	return jsonItem;
}

function unknownToJsonValue(value: unknown): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(unknownToJsonValue);
	}
	if (typeof value === "object") {
		const objectValue: { [key: string]: JsonValue | undefined } = {};
		for (const [key, child] of Object.entries(value)) {
			objectValue[key] = unknownToJsonValue(child);
		}
		return objectValue;
	}
	return null;
}

function invalidRequest(message: string): TurnEngineError {
	return new TurnEngineError({ code: -32600, message });
}

function invalidParams(message: string): TurnEngineError {
	return new TurnEngineError({ code: -32602, message });
}

function toTurnEngineError(error: unknown): TurnEngineError {
	if (error instanceof TurnEngineError) {
		return error;
	}
	return new TurnEngineError({ code: -32603, message: error instanceof Error ? error.message : String(error) });
}
