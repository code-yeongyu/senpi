import type { Socket } from "node:net";
import type { RpcConnectionSink } from "./connection-handler.ts";

/**
 * How long a CUT peer may still take to read the notice explaining its cut.
 *
 * A cut is always announced with one `overflow` record, but that record is written to a
 * transport the peer has stopped reading, so it usually sits in this socket's userspace
 * buffer. Destroying the socket there discards it and the client sees an unexplained EOF
 * (#1774). Half-close instead: the pending bytes - notice included - are flushed as soon
 * as the peer reads again, and only a peer that is still silent after this grace is
 * destroyed, which keeps the teardown bounded for a peer that never returns.
 */
export const SOCKET_CUT_GRACE_MS = 5_000;

/**
 * The output side of one accepted socket connection.
 *
 * `writeRaw` receives already-serialized JSONL text; `waitForBackpressure` reports the
 * transport's own `drain` signal, and `close` tears the connection down once its event
 * queue can no longer deliver (byte overflow, dead-peer stall, write failure).
 */
export function socketSink(socket: Socket): RpcConnectionSink {
	let needsDrain = false;
	let cut = false;
	return {
		writeRaw(chunk) {
			// Past the cut the writable side is already ended; a further write would only
			// raise ERR_STREAM_WRITE_AFTER_END on a connection that is going away.
			if (!cut && !socket.destroyed) needsDrain = !socket.write(chunk);
		},
		close() {
			if (cut) return;
			cut = true;
			if (socket.destroyed) return;
			socket.end();
			const grace = setTimeout(() => socket.destroy(), SOCKET_CUT_GRACE_MS);
			grace.unref();
			socket.once("close", () => clearTimeout(grace));
		},
		waitForBackpressure() {
			if (socket.destroyed || !needsDrain) return Promise.resolve();
			needsDrain = false;
			return new Promise<void>((resolve) => {
				const done = () => {
					socket.off("drain", done);
					socket.off("close", done);
					resolve();
				};
				socket.once("drain", done);
				socket.once("close", done);
			});
		},
	};
}
