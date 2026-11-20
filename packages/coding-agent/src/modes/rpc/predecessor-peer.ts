import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { attachJsonlLineReader, MAX_RPC_LINE_CHARACTERS, serializeJsonLine } from "./jsonl.ts";
import { connectAuthenticatedRpcSocket } from "./rpc-auth-client.ts";
import { DEFAULT_LOOP_LAG_ERROR_MS } from "./loop-lag-threshold.ts";
import { authRecord } from "./rpc-auth-proof.ts";

export type RouteRecord = Readonly<Record<string, unknown>>;
export class RouteDisconnected extends Error {
	readonly sent: boolean;
	constructor(sent: boolean) {
		super(sent ? "predecessor_delivery_outcome_unknown" : "predecessor_not_sent");
		this.sent = sent;
	}
}
/**
 * How long a predecessor may leave a request unanswered before it has to show it is alive: the host's own stall
 * threshold. A late answer is followed by a liveness probe, and a predecessor that answers neither is stalled.
 */
export const PREDECESSOR_REQUEST_TIMEOUT_MS = DEFAULT_LOOP_LAG_ERROR_MS;
/** A request the predecessor did not answer in time (`predecessor_request_timeout`); the connection is cut. */
export class RouteTimedOut extends Error {
	constructor() {
		super("predecessor_request_timeout");
	}
}
export interface RouteEndpoint {
	socket: string;
	launchId: string;
	instanceId: string;
	keyRoot: string;
}

/** One authenticated attachment per downstream connection and session. IDs and requester-only records never mix. */
export class PredecessorPeer {
	private readonly pending = new Map<string, ReturnType<typeof Promise.withResolvers<RouteRecord>>>();
	private readonly socket: Socket;
	readonly generation: number;
	private constructor(socket: Socket, generation: number, onRecord: (record: RouteRecord) => void, onEnd: () => void) {
		this.socket = socket;
		this.generation = generation;
		const detach = attachJsonlLineReader(
			socket,
			(line) => {
				let value: RouteRecord | undefined;
				try {
					value = authRecord(JSON.parse(line));
				} catch {
					socket.destroy();
					return;
				}
				if (!value) return;
				const pending =
					typeof value.id === "string" && value.type === "response" ? this.pending.get(value.id) : undefined;
				if (pending) pending.resolve(value);
				else onRecord(value);
			},
			{ maxLineLength: MAX_RPC_LINE_CHARACTERS, onOversizedLine: () => socket.destroy() },
		);
		socket.on("error", () => socket.destroy());
		socket.once("close", () => {
			detach();
			for (const pending of this.pending.values()) pending.reject(new RouteDisconnected(true));
			onEnd();
		});
	}
	static async connect(endpoint: RouteEndpoint, onRecord: (record: RouteRecord) => void, onEnd: () => void) {
		const { socket, protocol } = await connectAuthenticatedRpcSocket(endpoint.socket, undefined, {
			keyRoot: endpoint.keyRoot,
			expectedLaunchId: endpoint.launchId,
		});
		const data = authRecord(protocol.data);
		if (data?.instanceId !== endpoint.instanceId || typeof data.generation !== "number") {
			socket.destroy();
			throw new Error("predecessor_identity_mismatch");
		}
		return new PredecessorPeer(socket, data.generation, onRecord, onEnd);
	}
	/**
	 * Every request is bounded. `deadlineMs` is a fixed limit; without it the request waits while the predecessor stays
	 * alive, so a long command (`bash`, `compact` answer when their work is done) is never cut.
	 */
	async request(command: RouteRecord, deadlineMs?: number): Promise<RouteRecord> {
		if (this.socket.destroyed) throw new RouteDisconnected(false);
		const id = typeof command.id === "string" ? command.id : randomUUID();
		if (this.pending.has(id)) throw new Error("duplicate_request_id");
		const pending = Promise.withResolvers<RouteRecord>();
		this.pending.set(id, pending);
		try {
			this.socket.write(serializeJsonLine({ ...command, id }));
			return await (deadlineMs === undefined
				? this.answerWhileAlive(pending.promise)
				: within(pending.promise, deadlineMs));
		} catch (cause) {
			// Nothing a stalled predecessor sends later may still be read as an answer to a caller that gave up.
			if (cause instanceof RouteTimedOut) this.socket.destroy();
			throw cause;
		} finally {
			this.pending.delete(id);
		}
	}
	private async answerWhileAlive(answer: Promise<RouteRecord>): Promise<RouteRecord> {
		for (;;) {
			const answered = await within(answer, PREDECESSOR_REQUEST_TIMEOUT_MS).catch((cause: unknown) => {
				if (cause instanceof RouteTimedOut) return undefined;
				throw cause;
			});
			if (answered !== undefined) return answered;
			await this.request({ type: "get_protocol_info", observe: true }, PREDECESSOR_REQUEST_TIMEOUT_MS);
		}
	}
	send(record: RouteRecord): void {
		this.socket.write(serializeJsonLine(record));
	}
	close(): void {
		this.socket.destroy();
	}
}

function within<T>(answer: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new RouteTimedOut()), ms);
	});
	return Promise.race([answer, late]).finally(() => clearTimeout(timer));
}
