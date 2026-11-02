import { randomBytes } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attachJsonlLineReader, serializeJsonLine } from "../../src/modes/rpc/jsonl.ts";
import { PublicRpcConnection } from "../../src/modes/rpc/rpc-public-auth.ts";
import { RpcPublicEndpoint } from "../../src/modes/rpc/rpc-public-key.ts";
import { SOCKET_HANDSHAKE_TIMEOUT_MS } from "../../src/modes/rpc/socket-transport.ts";
import { Peer, proof, sandbox, teardown, type Wire } from "./rpc-public-auth-harness.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const DEPRECATION = "did not prove the endpoint key";
const DROPPED = "dropped an unauthenticated connection";

/**
 * The bare host's wiring in process: the filter's duplex feeds a router that answers every command it receives and,
 * like the real one, does not know `authenticate`.
 */
async function endpoint(requireToken: boolean) {
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	const qa = await sandbox();
	cleanups.push(() => teardown(qa.root));
	const key = new RpcPublicEndpoint(qa.agentDir, qa.socket);
	cleanups.push(() => key.dispose());
	await key.publish();
	const sockets = new Set<Socket>();
	const server: Server = createServer((socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		const router = new PublicRpcConnection(socket, key, requireToken).stream;
		router.on("error", () => {});
		attachJsonlLineReader(router, (line) => {
			const request = JSON.parse(line) as Wire;
			const known = request.type !== "authenticate";
			router.write(
				serializeJsonLine({
					type: "response",
					id: request.id,
					command: request.type,
					success: known,
					...(known ? { data: {} } : { error: "unknown command", errorCode: "unknown_command" }),
				}),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(qa.socket, resolve));
	cleanups.push(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const lines = (needle: string) =>
		stderr.mock.calls.map(([text]) => String(text)).filter((text) => text.includes(needle));
	return { qa, key, lines };
}

async function connect(path: string) {
	const peer = await Peer.connect(path);
	cleanups.push(async () => {
		peer.socket.destroy();
		await peer.closed;
	});
	return peer;
}

const large = (id: string) => ({ id, type: "list_sessions", padding: "x".repeat(9000) });

describe.skipIf(process.platform === "win32")("public endpoint pre-auth budget and drops (#3795)", () => {
	it("grace: serves a keyless first frame over 8 KiB with one deprecation line and no drop", async () => {
		const host = await endpoint(false);
		const peer = await connect(host.qa.socket);
		expect(await peer.request(large("big"))).toMatchObject({ id: "big", success: true });
		expect(await peer.request({ id: "next", type: "list_sessions" })).toMatchObject({ success: true });
		expect(host.lines(DEPRECATION)).toHaveLength(1);
		expect(host.lines(DROPPED)).toEqual([]);
	});

	it("grace: serves a keyless client over 8 KiB after a challenge it cannot answer (no key record)", async () => {
		const host = await endpoint(false);
		const peer = await connect(host.qa.socket);
		const nonce = randomBytes(32).toString("hex");
		const answer = await peer.request({ id: "p", type: "get_protocol_info", auth: { client_nonce: nonce } });
		expect(answer).toHaveProperty("data.auth.server_proof");
		expect(await peer.request(large("big"))).toMatchObject({ id: "big", success: true });
		expect(host.lines(DEPRECATION)).toHaveLength(1);
		expect(host.lines(DROPPED)).toEqual([]);
	});

	it("grace: a challenge in flight is not admitted by the deadline, so authenticate still reaches the filter", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const host = await endpoint(false);
		const peer = await connect(host.qa.socket);
		const nonce = randomBytes(32).toString("hex");
		const answer = await peer.request({ id: "p", type: "get_protocol_info", auth: { client_nonce: nonce } });
		const auth = (answer.data as { auth: { launch_id: string; server_nonce: string } }).auth;
		vi.advanceTimersByTime(SOCKET_HANDSHAKE_TIMEOUT_MS + 1);
		const client_proof = proof(host.key.key, "senpi-rpc-client", auth.launch_id, auth.server_nonce, nonce);
		expect(await peer.request({ id: "a", type: "authenticate", client_proof })).toMatchObject({
			command: "authenticate",
			success: true,
		});
		expect(host.lines(DEPRECATION)).toEqual([]);
	});

	it("enforcing: drops a pre-auth frame over 8 KiB and says why", async () => {
		const host = await endpoint(true);
		const peer = await connect(host.qa.socket);
		peer.socket.write(`${JSON.stringify(large("big"))}\n`);
		await peer.closed;
		expect(peer.records).toEqual([]);
		expect(host.lines(DROPPED)).toEqual([expect.stringContaining("pre-auth budget exceeded")]);
	});

	it("enforcing: answers a keyless first get_protocol_info with auth_required, closes, and says why", async () => {
		const host = await endpoint(true);
		const peer = await connect(host.qa.socket);
		expect(await peer.request({ id: "p", type: "get_protocol_info" })).toMatchObject({
			success: false,
			errorCode: "auth_required",
		});
		await peer.closed;
		expect(host.lines(DROPPED)).toEqual([expect.stringContaining("auth_required")]);
	});

	it("enforcing: drops a silent client at the handshake deadline and says why", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const host = await endpoint(true);
		const peer = await connect(host.qa.socket);
		vi.advanceTimersByTime(SOCKET_HANDSHAKE_TIMEOUT_MS + 1);
		await peer.closed;
		expect(host.lines(DROPPED)).toEqual([expect.stringContaining("pre-auth deadline")]);
	});

	it("drops a wrong proof with auth_failed and says why, without logging key material", async () => {
		const host = await endpoint(true);
		const peer = await connect(host.qa.socket);
		const nonce = randomBytes(32).toString("hex");
		await peer.request({ id: "p", type: "get_protocol_info", auth: { client_nonce: nonce } });
		expect(await peer.request({ id: "a", type: "authenticate", client_proof: "00".repeat(32) })).toMatchObject({
			errorCode: "auth_failed",
		});
		await peer.closed;
		const dropped = host.lines(DROPPED);
		expect(dropped).toEqual([expect.stringContaining("auth_failed")]);
		expect(dropped.join("")).not.toContain(host.key.key.toString("hex"));
	});
});
