/**
 * Local plaintext HTTP/2 fake Cursor backend exposing ONLY
 * `/agent.v1.AgentService/Run` (the senpi cursor-agent client speaks h2c
 * prior-knowledge; no h1 mux or unary bootstrap is needed).
 *
 * The handle exposes the decoded inbound timeline plus `send` for
 * server→client frames, so scenario playbooks can gate turnEnded on the
 * client's actual exec traffic.
 */

import * as http2 from "node:http2";
import { track } from "../../lib/common.mjs";
import { FrameLog } from "./frame-log.mjs";
import { RUN_PATH } from "./wire.mjs";

export async function startRunServer(wire, { expectedAuthorization }) {
	const server = http2.createServer();
	const log = new FrameLog(wire.summarizeClient);
	let runStream = null;
	let runCount = 0;
	let runWaiters = [];
	let headersReceipt = null;
	let streamClosed = null;
	const sessions = new Set();
	let closePromise = null;

	const waitForRun = (timeoutMs) =>
		runStream
			? Promise.resolve(runStream)
			: new Promise((resolve, reject) => {
					const waiter = {
						resolve,
						timer: setTimeout(() => {
							runWaiters.splice(runWaiters.indexOf(waiter), 1);
							reject(new Error(`Run stream did not open within ${timeoutMs}ms`));
						}, timeoutMs),
					};
					runWaiters.push(waiter);
				});

	server.on("stream", (stream, headers) => {
		if (String(headers[":path"] ?? "") !== RUN_PATH) {
			stream.respond({ ":status": 404 });
			stream.end();
			return;
		}
		runCount += 1;
		if (runStream) {
			log.note(`unexpected additional Run stream #${runCount} closed by server`);
			stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
			stream.end();
			return;
		}
		const authorization = String(headers.authorization ?? "");
		headersReceipt = {
			path: RUN_PATH,
			contentType: String(headers["content-type"] ?? ""),
			clientVersion: String(headers["x-cursor-client-version"] ?? ""),
			clientType: String(headers["x-cursor-client-type"] ?? ""),
			ghostMode: String(headers["x-ghost-mode"] ?? ""),
			te: String(headers.te ?? ""),
			authorization: authorization ? `Bearer *** (${authorization.length} chars)` : "(none)",
			authorizationMatchesExpected: authorization === expectedAuthorization,
		};
		streamClosed = new Promise((resolve) => stream.once("close", () => resolve("client closed the Run stream")));
		runStream = stream;
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		stream.on("data", (chunk) => log.feed(chunk));
		stream.on("error", (error) => log.close(`Run stream error: ${error.message}`));
		stream.once("close", () => log.close("client closed the Run stream"));
		for (const waiter of runWaiters.splice(0)) {
			clearTimeout(waiter.timer);
			waiter.resolve(stream);
		}
	});
	server.on("session", (session) => {
		sessions.add(session);
		session.once("close", () => sessions.delete(session));
	});

	const port = await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve(server.address().port));
	});
	track(server);

	return {
		port,
		log,
		get headersReceipt() {
			return headersReceipt;
		},
		get runCount() {
			return runCount;
		},
		waitForRun,
		waitFor(pred, timeoutMs, label) {
			return log.waitFor(pred, timeoutMs, label);
		},
		all(pred) {
			return log.all(pred);
		},
		send(buffer) {
			if (!runStream) throw new Error("send() before the Run stream opened");
			return new Promise((resolve, reject) => runStream.write(buffer, (error) => (error ? reject(error) : resolve())));
		},
		/** End the server→client direction (HTTP/2 END_STREAM) so the client's `end` fires. */
		endStream() {
			if (!runStream) throw new Error("endStream() before the Run stream opened");
			runStream.end();
		},
		async close() {
			if (closePromise) return closePromise;
			closePromise = (async () => {
				if (runStream && !runStream.closed) runStream.close();
				for (const session of sessions) session.destroy();
				await new Promise((resolve, reject) => {
					if (!server.listening) {
						resolve();
						return;
					}
					const timer = setTimeout(() => reject(new Error("Cursor QA h2 server did not close within 2000ms")), 2000);
					server.close(() => {
						clearTimeout(timer);
						resolve();
					});
				});
			})();
			return closePromise;
		},
		clientClosed() {
			return streamClosed ?? Promise.reject(new Error("Run stream never opened"));
		},
	};
}
