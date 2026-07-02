import assert from "node:assert/strict";
import { request } from "node:http";
import WebSocket from "ws";
import { ServerCore } from "../../../src/modes/app-server/server/server-core.ts";
import { startAppServerWebSocketListener } from "../../../src/modes/app-server/transports/websocket.ts";

const port = parsePort(process.argv.slice(2));
const handle = await startAppServerWebSocketListener({
	host: "127.0.0.1",
	port,
	auth: { kind: "off" },
	core: new ServerCore({ codexHome: "/tmp/senpi-task14-ws-noauth", version: "2026.7.2" }),
});

try {
	assert.equal(handle.port, port);
	assert.equal(await httpStatus(port, "/readyz"), 200);
	assert.equal(await httpStatus(port, "/healthz"), 200);
	assert.equal(await httpStatus(port, "/healthz", { Origin: "https://example.test" }), 403);
	assert.equal(await upgradeStatus(port, { Origin: "https://example.test" }), 403);

	const socket = await openSocket(port);
	socket.send(
		JSON.stringify({
			id: 1,
			method: "initialize",
			params: { clientInfo: { name: "qa-noauth", title: "QA", version: "0.0.1" } },
		}),
	);
	const response = await readSocketJson(socket);
	assert.equal(response.id, 1);
	assert.ok("result" in response);
	socket.close();
	console.log(JSON.stringify({ ok: true, port, checks: ["readyz", "healthz", "origin403", "noauthInitialize"] }));
} finally {
	await handle.close();
}

function parsePort(args: readonly string[]): number {
	const portIndex = args.indexOf("--port");
	const portValue = portIndex === -1 ? undefined : args[portIndex + 1];
	if (portValue === undefined) {
		throw new Error("Usage: task14-ws-noauth.ts --port <port>");
	}
	const parsedPort = Number(portValue);
	if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
		throw new Error(`Invalid port: ${portValue}`);
	}
	return parsedPort;
}

async function httpStatus(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
	const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
	await response.arrayBuffer();
	return response.status;
}

function upgradeStatus(port: number, headers: Record<string, string>): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = request({
			host: "127.0.0.1",
			port,
			path: "/",
			headers: {
				Connection: "Upgrade",
				"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
				"Sec-WebSocket-Version": "13",
				Upgrade: "websocket",
				...headers,
			},
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

function openSocket(port: number): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`ws://127.0.0.1:${port}/`);
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
				const parsed: unknown = JSON.parse(data.toString("utf8"));
				if (!isRecord(parsed)) {
					reject(new Error("expected object websocket payload"));
					return;
				}
				resolve(parsed);
			} catch (error: unknown) {
				reject(error);
			}
		});
		socket.once("error", reject);
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
