import { once } from "node:events";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptInternalConnection, connectInternalConnection } from "../../src/modes/rpc/internal-channel.ts";
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";
import { PublicRpcConnection } from "../../src/modes/rpc/rpc-public-auth.ts";
import { RpcPublicEndpoint } from "../../src/modes/rpc/rpc-public-key.ts";
import { sandbox, teardown } from "./rpc-public-auth-harness.ts";

/**
 * oh-my-openagent#14725: a long-running host held 10,183 accepted unix sockets whose peers had gone. The host serves
 * every connection through a wrapper stream (the sealed internal hop, the public key filter); a peer's FIN must end
 * that wrapper and release the socket by the host's own doing. These listeners leave a FIN to the socket's owner
 * (`allowHalfOpen: true`), as Bun's node:net sockets are half-open natively: a host that only closed because its
 * runtime turned the FIN into a close held every such socket for good.
 */
const PEERS = 50;
const RELEASE_DEADLINE_MS = 5_000;
const key = Buffer.alloc(32, 9);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listener(path: string, wrap: (socket: Socket) => Promise<Duplex> | Duplex) {
	const open = new Set<Socket>();
	const released: Promise<unknown>[] = [];
	const server: Server = createServer({ allowHalfOpen: true }, (socket) => {
		open.add(socket);
		released.push(once(socket, "close").then(() => open.delete(socket)));
		socket.on("error", () => {});
		void Promise.resolve(wrap(socket)).then(
			(stream) => {
				stream.on("error", () => {});
				attachJsonlLineReader(stream, () => {});
			},
			() => socket.destroy(),
		);
	});
	await new Promise<void>((resolve) => server.listen(path, resolve));
	cleanups.push(async () => {
		for (const socket of open) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return {
		async heldAfterDeadline(): Promise<number> {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const deadline = new Promise<void>((resolve) => {
				timer = setTimeout(resolve, RELEASE_DEADLINE_MS);
			});
			await Promise.race([Promise.all(released), deadline]);
			clearTimeout(timer);
			return open.size;
		},
		accepted: () => released.length,
	};
}

/** A half-open peer: after its own FIN it stays connected, so only the host can release the socket. */
async function peer(path: string, act: (socket: Socket) => Promise<void> | void): Promise<void> {
	const socket = createConnection({ path, allowHalfOpen: true });
	socket.on("error", () => {});
	cleanups.push(async () => {
		socket.destroy();
	});
	await once(socket, "connect");
	await act(socket);
}

describe.skipIf(process.platform === "win32")("accepted socket release on a peer FIN (omo#14725)", () => {
	it.each([
		["ends right after the handshake", (hop: Duplex) => hop.end()],
		["sends a request, then ends", (hop: Duplex) => hop.end('{"id":"1","type":"list_sessions"}\n')],
		["sends a partial line, then ends", (hop: Duplex) => hop.end('{"id":"1","type":"list_ses')],
	])("the sealed internal hop releases a peer that %s", async (_shape, finish) => {
		const qa = await sandbox();
		cleanups.push(() => teardown(qa.root));
		const host = await listener(qa.socket, (socket) => acceptInternalConnection(socket, key));
		for (let index = 0; index < PEERS; index++)
			await peer(qa.socket, async (socket) => {
				const hop = await connectInternalConnection(socket, key);
				hop.on("error", () => {});
				hop.resume();
				finish(hop);
			});
		expect(host.accepted()).toBe(PEERS);
		expect(await host.heldAfterDeadline()).toBe(0);
	});

	it.each([
		["ends without a hello", (socket: Socket) => socket.end()],
		["sends a request, then ends", (socket: Socket) => socket.end('{"id":"1","type":"list_sessions"}\n')],
		["sends a partial line, then ends", (socket: Socket) => socket.end('{"id":"1","type":"list_ses')],
	])("the public key filter releases a peer that %s", async (_shape, finish) => {
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const qa = await sandbox();
		cleanups.push(() => teardown(qa.root));
		const endpoint = new RpcPublicEndpoint(qa.agentDir, qa.socket);
		cleanups.push(() => endpoint.dispose());
		await endpoint.publish();
		const host = await listener(qa.socket, (socket) => new PublicRpcConnection(socket, endpoint, false).stream);
		for (let index = 0; index < PEERS; index++)
			await peer(qa.socket, (socket) => {
				socket.resume();
				finish(socket);
			});
		expect(host.accepted()).toBe(PEERS);
		expect(await host.heldAfterDeadline()).toBe(0);
	});
});
