import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { attachJsonlLineReader, MAX_RPC_LINE_CHARACTERS, serializeJsonLine } from "./jsonl.ts";
import { connectAuthenticatedRpcSocket } from "./rpc-auth-client.ts";
import { authRecord } from "./rpc-auth-proof.ts";

export type RouteRecord = Readonly<Record<string, unknown>>;
export class RouteDisconnected extends Error {
	readonly sent: boolean;
	constructor(sent: boolean) {
		super(sent ? "predecessor_delivery_outcome_unknown" : "predecessor_not_sent");
		this.sent = sent;
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
	async request(command: RouteRecord): Promise<RouteRecord> {
		if (this.socket.destroyed) throw new RouteDisconnected(false);
		const id = typeof command.id === "string" ? command.id : randomUUID();
		if (this.pending.has(id)) throw new Error("duplicate_request_id");
		const pending = Promise.withResolvers<RouteRecord>();
		this.pending.set(id, pending);
		try {
			this.socket.write(serializeJsonLine({ ...command, id }));
			return await pending.promise;
		} finally {
			this.pending.delete(id);
		}
	}
	send(record: RouteRecord): void {
		this.socket.write(serializeJsonLine(record));
	}
	close(): void {
		this.socket.destroy();
	}
}
