/**
 * senpi#4267: the terminal control socket admits only a client holding its secret, now on every platform (win32
 * included, over the named-pipe transport). A wrong secret is disconnected before one request line is read, so an
 * observer that never proved the secret gets zero records, not even an error. Security contract.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listenControlSocket, success } from "../interactive/session-control-server.ts";
import { resolveSocketTransportAddress } from "./socket-transport.ts";
import { tuiSocketName } from "./tui-socket.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function endpoint(): Promise<{ socket: string; secret: Buffer; served: string[] }> {
	const root = mkdtempSync(join(tmpdir(), "tui-observer-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const socket = join(root, tuiSocketName("observer-test"));
	const secret = randomBytes(32);
	const served: string[] = [];
	const server = await listenControlSocket(socket, secret, {
		command: async (_connection, command) => {
			served.push(command.type);
			return success(command.id, command.type, {});
		},
		closed: () => {},
		listenerError: () => {},
	});
	cleanups.push(() => server.close());
	return { socket, secret, served };
}

function exchange(socket: string, secret: Buffer, lines: readonly object[]): Promise<{ records: unknown[] }> {
	return new Promise((resolve, reject) => {
		const records: unknown[] = [];
		let buffer = "";
		const client = createConnection(resolveSocketTransportAddress(socket, process.platform, secret));
		client.once("connect", () => {
			client.write(secret);
			for (const line of lines) client.write(`${JSON.stringify(line)}\n`);
		});
		client.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			for (let nl = buffer.indexOf("\n"); nl !== -1; nl = buffer.indexOf("\n")) {
				records.push(JSON.parse(buffer.slice(0, nl)));
				buffer = buffer.slice(nl + 1);
				if (records.length === lines.length) client.end();
			}
		});
		client.on("error", reject);
		client.once("close", () => resolve({ records }));
	});
}

describe("terminal control socket observer auth (senpi#4267)", () => {
	it("wrong secret: the connection is closed with zero records and no command served", async () => {
		const { socket, secret, served } = await endpoint();
		const wrong = Buffer.from(secret.map((byte) => byte ^ 0xff));
		const client = createConnection(resolveSocketTransportAddress(socket, process.platform, secret));
		const records: string[] = [];
		client.on("data", (chunk: Buffer) => records.push(chunk.toString("utf8")));
		client.on("error", () => {});
		await new Promise<void>((resolve) => client.once("connect", () => resolve()));
		client.write(wrong);
		client.write(`${JSON.stringify({ type: "get_state", observe: true, id: "r1" })}\n`);
		await new Promise<void>((resolve) => client.once("close", () => resolve()));

		expect(records).toEqual([]);
		expect(served).toEqual([]);
	});

	it("serves an observing read to a client that sent the secret", async () => {
		const { socket, secret, served } = await endpoint();

		const { records } = await exchange(socket, secret, [{ type: "get_state", observe: true, id: "r1" }]);

		expect(records).toEqual([{ id: "r1", type: "response", command: "get_state", success: true, data: {} }]);
		expect(served).toEqual(["get_state"]);
	});
});
