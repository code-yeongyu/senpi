/**
 * One activity-neutral observer connection to a host or terminal endpoint: the socket handshake every
 * RPC socket shares, one `subscribe_sessions` frame, then every record the subscription delivers. It never
 * attaches and never sends input, so it counts as no attachment and refreshes no idle window. The
 * classic `RpcClient` is session-scoped (it drops records tagged with another session), so the monitor
 * reads the stream itself.
 */
import { createConnection, type Socket } from "node:net";
import { OBSERVE_REQUEST_FIELD } from "../../../../modes/rpc/host-observe-request.ts";
import { attachJsonlLineReader, MAX_RPC_LINE_CHARACTERS } from "../../../../modes/rpc/jsonl.ts";
import { connectAuthenticatedRpcSocket, type RpcKeyOptions } from "../../../../modes/rpc/rpc-auth-client.ts";
import {
	readSocketSecret,
	resolveSocketTransportAddress,
	sendSocketHandshake,
	socketSecretPath,
} from "../../../../modes/rpc/socket-transport.ts";
import { socketNeedsHandshake } from "../../../../modes/rpc/tui-socket.ts";
import type { subscriptionFor } from "./rpc-monitor-targets.ts";

export type RpcRecord = Readonly<Record<string, unknown>>;

export interface RpcObserverHandlers {
	/** Every record after the subscribe answer, in arrival order. */
	record(record: RpcRecord): void;
	/** The connection ended (host gone, refused, closed by `close()`). */
	closed(reason: string): void;
}

export interface RpcObserver {
	/** The subscribe answer: `snapshot`, `seq`, `hostGeneration`, `hostInstanceId`. */
	readonly subscribed: Promise<RpcRecord>;
	close(): void;
}

const SUBSCRIBE_ID = "monitor-subscribe";

export async function openRpcObserver(
	socketPath: string,
	subscription: ReturnType<typeof subscriptionFor>,
	handlers: RpcObserverHandlers,
	options: RpcKeyOptions = {},
): Promise<RpcObserver> {
	const secret = socketNeedsHandshake(socketPath) ? await readSocketSecret(socketSecretPath(socketPath)) : undefined;
	const authenticated = !socketNeedsHandshake(socketPath)
		? await connectAuthenticatedRpcSocket(socketPath, undefined, options)
		: undefined;
	const socket: Socket =
		authenticated?.socket ?? createConnection(resolveSocketTransportAddress(socketPath, process.platform, secret));
	const answer = Promise.withResolvers<RpcRecord>();
	const selector = subscription.sessions;
	const ids = typeof selector === "object" ? selector.ids : undefined;
	const routes = new Set<string>();
	const selects = (value: unknown) => typeof value === "string" && ids?.includes(value) === true;
	const matchesIdentity = (row: RpcRecord) =>
		selects(row.sessionId) || selects(row.durableSessionId) || selects(row.sessionPath);
	let admitted = false;
	let ended = false;
	const end = (reason: string): void => {
		if (ended) return;
		ended = true;
		answer.reject(new Error(`rpc monitor: ${socketPath}: ${reason}`));
		handlers.closed(reason);
	};
	const subscribe = () => {
		if (secret !== undefined) sendSocketHandshake(socket, secret);
		// Marked observing (senpi#3956): without it the supervisor counts this watch as an attached client, so a
		// watched host never idle-exits and a `children`/`all` watch pins every task shard host on the machine.
		const frame = { ...subscription, [OBSERVE_REQUEST_FIELD]: true, id: SUBSCRIBE_ID, type: "subscribe_sessions" };
		socket.write(`${JSON.stringify(frame)}\n`);
	};
	const detach = attachJsonlLineReader(
		socket,
		(line) => {
			let record: RpcRecord;
			try {
				record = JSON.parse(line) as RpcRecord;
			} catch {
				return;
			}
			if (record.type === "response" && record.id === SUBSCRIBE_ID) {
				if (record.success === true) {
					// Install the endpoint-local routes before decoding the next line, even in the same read.
					const data = record.data as RpcRecord | undefined;
					if (ids && Array.isArray(data?.snapshot)) {
						const snapshot = data.snapshot.filter((row: RpcRecord) => {
							if (typeof row?.sessionId !== "string") return false;
							if (!matchesIdentity(row)) return false;
							routes.add(row.sessionId);
							return true;
						});
						admitted = snapshot.length > 0;
						answer.resolve({ ...record, data: { ...data, snapshot } });
					} else answer.resolve(record);
				} else {
					answer.reject(new Error(`rpc monitor: ${socketPath} refused the subscription: ${String(record.error)}`));
					socket.destroy();
				}
				return;
			}
			if (ids) {
				const route = record.sessionId;
				if (!admitted || typeof route !== "string") return;
				// A matching session may reopen under a new handle on this endpoint.
				if (record.type === "session_status") {
					if (matchesIdentity(record)) routes.add(route);
					else routes.delete(route);
				}
				if (
					record.type === "session_replaced" &&
					!selects(route) &&
					!selects(record.durableSessionId) &&
					!selects(record.sessionFile)
				)
					routes.delete(route);
				if (!routes.has(route)) return;
				if (record.type === "session_closed" || record.type === "session_parked") routes.delete(route);
			}
			handlers.record(record);
		},
		{ maxLineLength: MAX_RPC_LINE_CHARACTERS },
	);
	socket.on("error", (error) => end(error.message));
	socket.once("close", () => {
		detach();
		end("connection closed");
	});
	if (authenticated) subscribe();
	else socket.once("connect", subscribe);
	return {
		subscribed: answer.promise,
		close: () => socket.destroy(),
	};
}
