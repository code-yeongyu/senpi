import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { ServerCore } from "../../src/modes/app-server/server/server-core.ts";
import {
	startAppServerWebSocketListener,
	type WebSocketListenerHandle,
} from "../../src/modes/app-server/transports/websocket.ts";

const HANDSHAKE_HEADERS = {
	Connection: "Upgrade",
	"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
	"Sec-WebSocket-Version": "13",
	Upgrade: "websocket",
} as const;

const token = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const handles: WebSocketListenerHandle[] = [];

describe("app-server websocket listener", () => {
	afterEach(async () => {
		await Promise.all(handles.splice(0).map((handle) => handle.close()));
	});

	it("returns ready and health probes while accepting", async () => {
		// Given: a websocket listener on an ephemeral loopback port.
		const handle = await startListener({ auth: { kind: "off" } });

		// When: health probes are requested over HTTP.
		const ready = await fetch(`http://${handle.host}:${handle.port}/readyz`);
		const health = await fetch(`http://${handle.host}:${handle.port}/healthz`);

		// Then: both probes report the accepting listener as healthy.
		expect(ready.status).toBe(200);
		expect(await ready.text()).toBe("ok\n");
		expect(health.status).toBe(200);
		expect(await health.text()).toBe("ok\n");
	});

	it("rejects requests and upgrades that include Origin", async () => {
		// Given: a websocket listener on loopback.
		const handle = await startListener({ auth: { kind: "off" } });

		// When: HTTP and upgrade requests include an Origin header.
		const health = await fetch(`http://${handle.host}:${handle.port}/healthz`, {
			headers: { Origin: "https://example.test" },
		});
		const upgrade = await requestUpgradeStatus(handle.port, { Origin: "https://example.test" });

		// Then: both are rejected before normal route or upgrade handling.
		expect(health.status).toBe(403);
		expect(upgrade).toBe(403);
	});

	it("requires bearer auth before accepting upgrades", async () => {
		// Given: a websocket listener with a bearer token file.
		const dir = await mkdtemp(join(tmpdir(), "senpi-app-server-ws-auth-"));
		const tokenFile = join(dir, "ws-token");
		await writeFile(tokenFile, token, { mode: 0o600 });
		const handle = await startListener({ auth: { kind: "token-file", path: tokenFile } });

		// When: the client attempts a websocket upgrade without Authorization.
		const status = await requestUpgradeStatus(handle.port);

		// Then: the upgrade fails closed with 401.
		expect(status).toBe(401);
		await rm(dir, { recursive: true, force: true });
	});

	it("round-trips initialize over a real websocket with bearer auth", async () => {
		// Given: a websocket listener with a token-protected upgrade.
		const handle = await startListener({ auth: { kind: "token-value", token } });
		const socket = await openSocket(handle.port, token);

		// When: initialize is sent as one text frame.
		socket.send(
			JSON.stringify({
				id: 1,
				method: "initialize",
				params: { clientInfo: { name: "qa", title: "QA", version: "0.0.1" } },
			}),
		);
		const response = await readSocketJson(socket);

		// Then: the server responds with the app-server initialize result.
		expect(response).toEqual({ id: 1, result: expect.any(Object) });
		expectRecord(response.result);
		expect(response.result.userAgent).toEqual(expect.stringMatching(/^qa\/2026\.7\.2 \(.+\) senpi_app_server$/));
		socket.close();
	});

	it("serves two concurrent initialized websocket clients", async () => {
		// Given: one listener and two authenticated websocket clients.
		const handle = await startListener({ auth: { kind: "token-value", token } });
		const first = await openSocket(handle.port, token);
		const second = await openSocket(handle.port, token);

		// When: both clients initialize concurrently.
		first.send(JSON.stringify(initializeRequest(1, "qa-a")));
		second.send(JSON.stringify(initializeRequest(2, "qa-b")));
		const [firstResponse, secondResponse] = await Promise.all([readSocketJson(first), readSocketJson(second)]);

		// Then: each client receives its own initialize response.
		expect(firstResponse).toEqual({ id: 1, result: expect.any(Object) });
		expect(secondResponse).toEqual({ id: 2, result: expect.any(Object) });
		expect(handle.connectionCount).toBe(2);
		first.close();
		second.close();
	});

	it("drops binary frames without closing the connection", async () => {
		// Given: an authenticated websocket client.
		const handle = await startListener({ auth: { kind: "token-value", token } });
		const socket = await openSocket(handle.port, token);

		// When: a binary frame is followed by a valid initialize text frame.
		socket.send(Buffer.from("not-json"));
		socket.send(JSON.stringify(initializeRequest(1, "qa-binary")));
		const response = await readSocketJson(socket);

		// Then: the binary frame is ignored and the text request succeeds.
		expect(response).toEqual({ id: 1, result: expect.any(Object) });
		socket.close();
	});

	it("closes websocket clients with 1013 when outbound backpressure overflows", async () => {
		// Given: a listener with a tiny outbound byte limit and an initialized client.
		const handle = await startListener({ auth: { kind: "token-value", token }, outboundQueueBytes: 512 });
		const socket = await openSocket(handle.port, token);
		socket.send(JSON.stringify(initializeRequest(1, "qa-backpressure")));
		await readSocketJson(socket);

		// When: the server attempts to send an oversized outbound notification.
		const closed = waitForClose(socket);
		await handle.core.sendNotificationToConnection("ws-1", {
			method: "thread/status/changed",
			params: { threadId: "thread-1", status: { type: "idle" }, payload: "x".repeat(1024) },
		});

		// Then: the transport closes the slow client with the retry-later websocket code.
		await expect(closed).resolves.toMatchObject({ code: 1013 });
	});
});

function initializeRequest(id: number, name: string): Record<string, unknown> {
	return {
		id,
		method: "initialize",
		params: { clientInfo: { name, title: "QA", version: "0.0.1" } },
	};
}

async function startListener(options: {
	readonly auth:
		| { readonly kind: "off" }
		| { readonly kind: "token-file"; readonly path: string }
		| { readonly kind: "token-value"; readonly token: string };
	readonly outboundQueueBytes?: number;
}): Promise<WebSocketListenerHandle> {
	const handle = await startAppServerWebSocketListener({
		host: "127.0.0.1",
		port: 0,
		auth: options.auth,
		core: new ServerCore({ codexHome: "/tmp/senpi-ws-test-home", version: "2026.7.2" }),
		outboundQueueBytes: options.outboundQueueBytes,
	});
	handles.push(handle);
	return handle;
}

function requestUpgradeStatus(port: number, headers: Record<string, string> = {}): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = request({
			host: "127.0.0.1",
			port,
			path: "/",
			headers: { ...HANDSHAKE_HEADERS, ...headers },
		});
		req.once("upgrade", () => {
			resolve(101);
			req.destroy();
		});
		req.once("response", (response) => {
			resolve(response.statusCode ?? 0);
			response.resume();
		});
		req.once("error", reject);
		req.end();
	});
}

function openSocket(port: number, bearerToken: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`ws://127.0.0.1:${port}/`, {
			headers: { Authorization: `Bearer ${bearerToken}` },
		});
		socket.once("open", () => resolve(socket));
		socket.once("error", reject);
	});
}

function readSocketJson(socket: WebSocket): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		socket.once("message", (data, isBinary) => {
			if (isBinary) {
				reject(new Error("expected text websocket frame"));
				return;
			}
			try {
				const text = typeof data === "string" ? data : data.toString("utf8");
				const parsed: unknown = JSON.parse(text);
				expectRecord(parsed);
				resolve(parsed);
			} catch (error: unknown) {
				reject(error);
			}
		});
		socket.once("error", reject);
	});
}

function waitForClose(socket: WebSocket): Promise<{ readonly code: number; readonly reason: string }> {
	return new Promise((resolve) => {
		socket.once("close", (code, reason) => {
			resolve({ code, reason: reason.toString("utf8") });
		});
	});
}

function expectRecord(value: unknown): asserts value is Record<string, unknown> {
	expect(typeof value).toBe("object");
	expect(value).not.toBeNull();
	expect(Array.isArray(value)).toBe(false);
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("expected record");
	}
}
