/**
 * One activity-neutral observer connection to a host or terminal endpoint: the socket handshake every
 * RPC socket shares, one `subscribe_sessions` frame, then every record the subscription delivers. It never
 * attaches and never sends input, so it counts as no attachment and refreshes no idle window. The
 * classic `RpcClient` is session-scoped (it drops records tagged with another session), so the monitor
 * reads the stream itself.
 */
import { createConnection, type Socket } from "node:net";
import { attachJsonlLineReader, MAX_RPC_LINE_CHARACTERS } from "../../../../modes/rpc/jsonl.ts";
import {
	readSocketSecret,
	resolveSocketTransportAddress,
	sendSocketHandshake,
	socketSecretPath,
} from "../../../../modes/rpc/socket-transport.ts";
import { socketNeedsHandshake } from "../../../../modes/rpc/tui-socket.ts";

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
	subscription: RpcRecord,
	handlers: RpcObserverHandlers,
): Promise<RpcObserver> {
	const secret = socketNeedsHandshake(socketPath) ? await readSocketSecret(socketSecretPath(socketPath)) : undefined;
	const socket: Socket = createConnection(resolveSocketTransportAddress(socketPath, process.platform, secret));
	const answer = Promise.withResolvers<RpcRecord>();
	let ended = false;
	const end = (reason: string): void => {
		if (ended) return;
		ended = true;
		answer.reject(new Error(`rpc monitor: ${socketPath}: ${reason}`));
		handlers.closed(reason);
	};
	socket.once("connect", () => {
		if (secret !== undefined) sendSocketHandshake(socket, secret);
		socket.write(`${JSON.stringify({ ...subscription, id: SUBSCRIBE_ID, type: "subscribe_sessions" })}\n`);
	});
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
				if (record.success === true) answer.resolve(record);
				else {
					answer.reject(new Error(`rpc monitor: ${socketPath} refused the subscription: ${String(record.error)}`));
					socket.destroy();
				}
				return;
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
	return {
		subscribed: answer.promise,
		close: () => socket.destroy(),
	};
}
