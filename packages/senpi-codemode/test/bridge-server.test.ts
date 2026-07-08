import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { type BridgeHttpEmitEvent, startBridgeServer } from "../src/bridge/http-server.ts";

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

async function waitForPortReleased(port: number): Promise<void> {
	const probe = createServer();
	await new Promise<void>((resolve, reject) => {
		probe.once("error", reject);
		probe.listen(port, "127.0.0.1", () => resolve());
	});
	await new Promise<void>((resolve, reject) => {
		probe.close((error) => (error ? reject(error) : resolve()));
	});
}

describe("bridge HTTP server", () => {
	it("handles authenticated tool calls through an injected handler", async () => {
		const server = await startBridgeServer({
			token: "test-token",
			onCall: async (request) => ({ toolName: request.toolName, args: request.args }),
			onEmit: async () => {},
			onCompletion: async () => "unused",
		});
		try {
			expect(server.port).toBeGreaterThan(0);
			const response = await postJson(server.port, "/call", server.token, {
				callId: "call-1",
				toolName: "echo",
				args: { q: "hi" },
			});
			await expect(response.json()).resolves.toEqual({
				ok: true,
				value: { toolName: "echo", args: { q: "hi" } },
			});
		} finally {
			await server.close();
		}
	});

	it("rejects missing or wrong bearer tokens without leaking the configured token", async () => {
		const server = await startBridgeServer({
			token: "secret-token",
			onCall: async () => "unused",
			onEmit: async () => {},
			onCompletion: async () => "unused",
		});
		try {
			const response = await postJson(server.port, "/call", "wrong-token", {
				callId: "call-1",
				toolName: "echo",
				args: {},
			});
			expect(response.status).toBe(401);
			const body = await response.json();
			expect(body).toEqual({ ok: false, error: { code: "unauthorized", message: expect.any(String) } });
			expect(JSON.stringify(body)).not.toContain("secret-token");
		} finally {
			await server.close();
		}
	});

	it("validates routes and request bodies with typed transport errors", async () => {
		const server = await startBridgeServer({
			token: "test-token",
			bodyLimitBytes: 16,
			onCall: async () => "unused",
			onEmit: async () => {},
			onCompletion: async () => "unused",
		});
		try {
			expect((await postJson(server.port, "/missing", server.token, {})).status).toBe(404);

			const malformed = await fetch(`http://127.0.0.1:${server.port}/call`, {
				method: "POST",
				headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
				body: "{",
			});
			expect(malformed.status).toBe(400);
			await expect(malformed.json()).resolves.toEqual({
				ok: false,
				error: { code: "invalid_json", message: expect.any(String) },
			});

			const oversized = await postJson(server.port, "/call", server.token, { payload: "x".repeat(64) });
			expect(oversized.status).toBe(413);
			await expect(oversized.json()).resolves.toEqual({
				ok: false,
				error: { code: "body_too_large", message: expect.any(String) },
			});
		} finally {
			await server.close();
		}
	});

	it("returns protocol-level errors for handler failures", async () => {
		const server = await startBridgeServer({
			token: "test-token",
			onCall: async () => {
				throw new Error("tool failed");
			},
			onEmit: async () => {},
			onCompletion: async () => "unused",
		});
		try {
			const response = await postJson(server.port, "/call", server.token, {
				callId: "call-1",
				toolName: "boom",
				args: {},
			});
			expect(response.status).toBe(200);
			await expect(response.json()).resolves.toEqual({
				ok: false,
				error: { message: "tool failed", name: "Error", stack: expect.any(String) },
			});
		} finally {
			await server.close();
		}
	});

	it("forwards emit and completion requests", async () => {
		const events: BridgeHttpEmitEvent[] = [];
		const server = await startBridgeServer({
			token: "test-token",
			onCall: async () => "unused",
			onEmit: async (event) => {
				events.push(event);
			},
			onCompletion: async (request) => ({ prompt: request.prompt, opts: request.opts }),
		});
		try {
			const emit = await postJson(server.port, "/emit", server.token, {
				kind: "text",
				stream: "stdout",
				data: "hello",
			});
			expect(emit.status).toBe(204);
			expect(events).toEqual([{ kind: "text", stream: "stdout", data: "hello" }]);

			const completion = await postJson(server.port, "/completion", server.token, {
				prompt: "Say hi",
				opts: { model: "default" },
			});
			await expect(completion.json()).resolves.toEqual({
				ok: true,
				value: { prompt: "Say hi", opts: { model: "default" } },
			});
		} finally {
			await server.close();
		}
	});

	it("resolves concurrent calls and releases the port after close", async () => {
		const server = await startBridgeServer({
			token: "test-token",
			onCall: async (request) => request.callId,
			onEmit: async () => {},
			onCompletion: async () => "unused",
		});
		const port = server.port;
		const replies = await Promise.all(
			Array.from({ length: 10 }, (_, index) =>
				postJson(port, "/call", server.token, {
					callId: `call-${index}`,
					toolName: "echo",
					args: { index },
				}).then(async (response) => await response.json()),
			),
		);
		expect(replies).toEqual(Array.from({ length: 10 }, (_, index) => ({ ok: true, value: `call-${index}` })));

		await server.close();
		await server.close();
		await waitForPortReleased(port);
	});

	it("closes active sockets when stopped during an in-flight call", async () => {
		let callStarted: (() => void) | undefined;
		let releaseCall: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			callStarted = resolve;
		});
		const server = await startBridgeServer({
			token: "test-token",
			onCall: async () => {
				callStarted?.();
				await new Promise<void>((resolve) => {
					releaseCall = resolve;
				});
				return "late";
			},
			onEmit: async () => {},
			onCompletion: async () => "unused",
		});
		const pending = postJson(server.port, "/call", server.token, {
			callId: "call-1",
			toolName: "slow",
			args: {},
		});
		await started;
		await server.close();
		releaseCall?.();
		await expect(pending).rejects.toThrow();
		await waitForPortReleased(server.port);
	});
});
