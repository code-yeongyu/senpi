import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { HostAdmission } from "../../src/modes/rpc/host-admission.ts";
import { ClientOccupancy } from "../../src/modes/rpc/host-client-occupancy.ts";
import { createPublicProxy } from "../../src/modes/rpc/host-lifecycle-proxy.ts";
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
describe.skipIf(process.platform === "win32")("authenticated internal connections", () => {
	it("uses the canonical newline/hex HMAC frames before encrypted traffic", async () => {
		const root = mkdtempSync("/tmp/rpc-hop-wire-");
		roots.push(root);
		const path = join(root, "host.sock");
		const proofChecked = Promise.withResolvers<{ actual: unknown; expected: string }>();
		const server = createServer((socket) => {
			sockets.push(socket);
			attachJsonlLineReader(socket, (line) => {
				const frame = JSON.parse(line);
				if (frame.type === "get_protocol_info") {
					expect(frame.auth.client_nonce).toMatch(/^[a-f0-9]{64}$/);
					const nonce = "0b".repeat(32);
					socket.write(
						`${JSON.stringify({
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
						})}\n`,
					);
					socket.once("data", (data) => {
						proofChecked.resolve({
							actual: JSON.parse(String(data)),
							expected: createHmac("sha256", key)
								.update(`senpi-rpc-client\ninternal\n${nonce}\n${frame.auth.client_nonce}`)
								.digest("hex"),
						});
					});
				} else if (frame.type === "authenticate")
					socket.write(
						`${JSON.stringify({ id: frame.id, type: "response", command: "authenticate", success: true })}\n`,
					);
			});
		});
		await listen(server, path);
		const stream = await connectInternalConnection(peer(path), key);
		sockets.push(stream);
		expect(stream.destroyed).toBe(false);
		const { actual, expected } = await proofChecked.promise;
		expect(actual).toMatchObject({ type: "authenticate", client_proof: expected });
	});

	it("rejects a listener that cannot prove the internal key", async () => {
		const root = mkdtempSync("/tmp/rpc-hop-forged-");
		roots.push(root);
		const path = join(root, "host.sock");
		await listen(
			createServer((socket) => {
				sockets.push(socket);
				void acceptInternalConnection(socket, Buffer.alloc(32, 8)).catch(() => socket.destroy());
			}),
			path,
		);
		await expect(connectInternalConnection(peer(path), key)).rejects.toThrow();
	});

	it("a substituted socket relay cannot inject list_sessions after authentication and the proxy loses the hop", async () => {
		const root = mkdtempSync("/tmp/rpc-hop-relay-");
		roots.push(root);
		const hostPath = join(root, "real");
		const relayPath = join(root, "relay");
		const publicPath = join(root, "public");
		const commands: string[] = [];
		await listen(
			createServer((socket) => {
				sockets.push(socket);
				void acceptInternalConnection(socket, key)
					.then((stream) => {
						sockets.push(stream);
						stream.on("error", () => {});
						attachJsonlLineReader(stream, (line) => commands.push(JSON.parse(line).type));
					})
					.catch(() => socket.destroy());
			}),
			hostPath,
		);
		let inject: (() => void) | undefined;
		const authenticated = Promise.withResolvers<void>();
		await listen(
			createServer((client) => {
				sockets.push(client);
				const host = peer(hostPath);
				client.pipe(host);
				let pending = "";
				host.on("data", (data: Buffer) => {
					client.write(data);
					if (inject) return;
					pending += data.toString();
					if (pending.includes('"command":"authenticate"')) {
						inject = () => host.write('{"id":"forged","type":"list_sessions"}\n');
						authenticated.resolve();
					}
				});
				host.on("close", () => client.destroy());
				client.on("close", () => host.destroy());
			}),
			relayPath,
		);
		const proxy = createPublicProxy({
			internalSocket: relayPath,
			internalKey: key,
			clients: new ClientOccupancy(() => {}),
			admission: new HostAdmission({
				protocolVersion: 1,
				serverVersion: "test",
				capabilities: [],
				instanceId: "test",
			}),
			onDetach: () => {},
		});
		await listen(proxy, publicPath);
		const client = peer(publicPath);
		await authenticated.promise;
		const closed = once(client, "close");
		inject?.();
		await closed;
		expect(commands).toEqual([]);
	});
});
