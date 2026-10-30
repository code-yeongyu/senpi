import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { acceptInternalConnection, connectInternalConnection } from "../../src/modes/rpc/internal-channel.ts";
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";

const key = Buffer.alloc(32, 7);
const sockets: Duplex[] = [];
const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.destroy();
	for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function listen(server: Server, path: string) {
	servers.push(server);
	const ready = once(server, "listening");
	server.listen(path);
	await ready;
}
function peer(path: string): Socket {
	const socket = createConnection(path);
	sockets.push(socket);
	return socket;
}

// senpi#3795: no legacy/downgrade path on the private hop.
// senpi#3795 wire contract frame 5 and the client-side budget (split out of rpc-internal-channel.test.ts).
describe.skipIf(process.platform === "win32")("internal connection refusals and budgets", () => {
	// Wire contract frame 5: a missing or malformed first-frame nonce, or any command before authentication,
	// is answered auth_required naming that command, then closed. A wrong proof stays auth_failed.
	async function rawExchange(send: (write: (frame: object) => void, responses: Record<string, unknown>[]) => void) {
		const root = mkdtempSync("/tmp/rpc-hop-frame5-");
		roots.push(root);
		const path = join(root, "host.sock");
		await listen(
			createServer((socket) => {
				sockets.push(socket);
				void acceptInternalConnection(socket, key).catch(() => {});
			}),
			path,
		);
		const client = peer(path);
		const responses: Record<string, unknown>[] = [];
		const closed = once(client, "close");
		attachJsonlLineReader(client, (line) => {
			responses.push(JSON.parse(line));
			send((frame) => client.write(`${JSON.stringify(frame)}\n`), responses);
		});
		await once(client, "connect");
		send((frame) => client.write(`${JSON.stringify(frame)}\n`), responses);
		await closed;
		return responses;
	}
	const authRequired = (id: string, command: string) => ({
		id,
		type: "response",
		command,
		success: false,
		error: "auth_required",
		errorCode: "auth_required",
	});

	it.each([
		["no", undefined],
		["a malformed", { client_nonce: "zz" }],
	])("answers a first frame with %s client nonce auth_required, then closes", async (_label, auth) => {
		const responses = await rawExchange((write, received) => {
			if (received.length === 0) write({ id: "p", type: "get_protocol_info", ...(auth ? { auth } : {}) });
		});
		expect(responses).toEqual([authRequired("p", "get_protocol_info")]);
	});

	it("answers a command sent before authenticate auth_required naming it, then closes", async () => {
		const responses = await rawExchange((write, received) => {
			if (received.length === 0)
				write({ id: "p", type: "get_protocol_info", auth: { client_nonce: "0a".repeat(32) } });
			else if (received.length === 1) write({ id: "x", type: "list_sessions" });
		});
		expect(responses).toHaveLength(2);
		expect(responses[1]).toEqual(authRequired("x", "list_sessions"));
	});

	it("keeps a wrong proof auth_failed, then closes", async () => {
		const responses = await rawExchange((write, received) => {
			if (received.length === 0)
				write({ id: "p", type: "get_protocol_info", auth: { client_nonce: "0a".repeat(32) } });
			else if (received.length === 1) write({ id: "a", type: "authenticate", client_proof: "00".repeat(32) });
		});
		expect(responses).toHaveLength(2);
		expect(responses[1]).toEqual({
			id: "a",
			type: "response",
			command: "authenticate",
			success: false,
			error: "auth_failed",
			errorCode: "auth_failed",
		});
	});

	// senpi#3816 review: the 2 s / 8 KiB pre-auth budget is the host's (server) guard. A supervisor-side client
	// whose host answers late (a stalled engine event loop) must still connect, as raw connections did.
	it("completes a client handshake whose host answers after more than 2 s", async () => {
		const root = mkdtempSync("/tmp/rpc-hop-slow-");
		roots.push(root);
		const path = join(root, "host.sock");
		await listen(
			createServer((socket) => {
				sockets.push(socket);
				attachJsonlLineReader(socket, (line) => {
					const frame = JSON.parse(line);
					if (frame.type === "get_protocol_info") {
						const nonce = "0c".repeat(32);
						const answer = {
							id: frame.id,
							type: "response",
							command: frame.type,
							success: true,
							data: {
								capabilities: ["socket_auth"],
								auth: {
									launch_id: "internal",
									server_nonce: nonce,
									server_proof: createHmac("sha256", key)
										.update(`senpi-rpc-server\ninternal\n${frame.auth.client_nonce}\n${nonce}`)
										.digest("hex"),
								},
							},
						};
						setTimeout(() => socket.write(`${JSON.stringify(answer)}\n`), 2_500);
					} else if (frame.type === "authenticate")
						socket.write(
							`${JSON.stringify({ id: frame.id, type: "response", command: "authenticate", success: true })}\n`,
						);
				});
			}),
			path,
		);
		const stream = await connectInternalConnection(peer(path), key);
		sockets.push(stream);
		expect(stream.destroyed).toBe(false);
	}, 10_000);
});
