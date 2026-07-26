import { once } from "node:events";
import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { startBridgeServer } from "../src/bridge/http-server.ts";

async function postJson(port: number, path: string, token: string, body: unknown): Promise<Response> {
	return await fetch(`http://127.0.0.1:${port}${path}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
}

describe("bridge HTTP server call signals", () => {
	it("keeps the onCall signal live while a normal request is being handled", async () => {
		const samples: boolean[] = [];
		const server = await startBridgeServer({
			token: "test-token",
			onCall: async (request) => {
				samples.push(request.signal.aborted);
				// Let the event loop drain any pending request-lifecycle events
				// (IncomingMessage "close" fires on message completion in Node >= 16)
				// before sampling again.
				await new Promise<void>((resolve) => setImmediate(resolve));
				await new Promise<void>((resolve) => setImmediate(resolve));
				samples.push(request.signal.aborted);
				return "alive";
			},
			onEmit: async () => {},
			onCompletion: async () => "unused",
		});
		try {
			const response = await postJson(server.port, "/call", server.token, {
				callId: "call-signal-1",
				toolName: "echo",
				args: {},
			});
			await expect(response.json()).resolves.toEqual({ ok: true, value: "alive" });
			expect(samples).toEqual([false, false]);
		} finally {
			await server.close();
		}
	});

	it("keeps the onCompletion signal live while a normal request is being handled", async () => {
		const samples: boolean[] = [];
		const server = await startBridgeServer({
			token: "test-token",
			onCall: async () => "unused",
			onEmit: async () => {},
			onCompletion: async (request) => {
				samples.push(request.signal.aborted);
				await new Promise<void>((resolve) => setImmediate(resolve));
				await new Promise<void>((resolve) => setImmediate(resolve));
				samples.push(request.signal.aborted);
				return "alive";
			},
		});
		try {
			const response = await postJson(server.port, "/completion", server.token, { prompt: "hello" });
			await expect(response.json()).resolves.toEqual({ ok: true, value: "alive" });
			expect(samples).toEqual([false, false]);
		} finally {
			await server.close();
		}
	});

	it("aborts the in-flight onCall signal when the client disconnects prematurely", async () => {
		let callStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			callStarted = resolve;
		});
		let abortObserved: (() => void) | undefined;
		const aborted = new Promise<void>((resolve) => {
			abortObserved = resolve;
		});
		const server = await startBridgeServer({
			token: "test-token",
			onCall: async (request) => {
				callStarted?.();
				if (request.signal.aborted) abortObserved?.();
				else request.signal.addEventListener("abort", () => abortObserved?.(), { once: true });
				await aborted;
				return "late";
			},
			onEmit: async () => {},
			onCompletion: async () => "unused",
		});
		try {
			const body = JSON.stringify({ callId: "call-signal-2", toolName: "slow", args: {} });
			const socket = connect(server.port, "127.0.0.1");
			await once(socket, "connect");
			socket.write(
				`POST /call HTTP/1.1\r\nhost: 127.0.0.1\r\nauthorization: Bearer test-token\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
			);
			await started;
			socket.destroy();
			await aborted;
		} finally {
			await server.close();
		}
	});
});
