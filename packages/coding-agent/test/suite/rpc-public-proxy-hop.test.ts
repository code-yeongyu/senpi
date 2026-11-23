import { once } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostAdmission } from "../../src/modes/rpc/host-admission.ts";
import { ClientOccupancy } from "../../src/modes/rpc/host-client-occupancy.ts";
import { createPublicProxy } from "../../src/modes/rpc/host-lifecycle-proxy.ts";
import { PEER_END_REPLY_GRACE_MS } from "../../src/modes/rpc/host-peer-end.ts";
import { acceptInternalConnection } from "../../src/modes/rpc/internal-channel.ts";
import { sandbox, teardown } from "./rpc-public-auth-harness.ts";

// oh-my-openagent#14725: the supervisor's public proxy in process, with its host child replaced by a listener the test
// controls. The supervisor logs through a synchronous fd-2 write (host-supervisor-log.ts); the spy reaches it through
// node:fs's named exports, re-synced after the spy is installed and after it is removed.
const key = Buffer.alloc(32, 5);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function supervisorLines() {
	const lines: string[] = [];
	const waiters: Array<{ readonly match: RegExp; readonly resolve: () => void }> = [];
	const write = fs.writeSync;
	vi.spyOn(fs, "writeSync").mockImplementation((fd, data, position, encoding) => {
		if (fd !== 2) return write(fd, data, position, encoding);
		lines.push(data);
		for (const waiter of waiters.splice(0)) {
			if (waiter.match.test(data)) waiter.resolve();
			else waiters.push(waiter);
		}
		return data.length;
	});
	syncBuiltinESMExports();
	return {
		matching: (match: RegExp) => lines.filter((line) => match.test(line)),
		appears: (match: RegExp) =>
			lines.some((line) => match.test(line))
				? Promise.resolve()
				: new Promise<void>((resolve) => waiters.push({ match, resolve })),
	};
}

async function listen(server: Server, path: string): Promise<void> {
	await new Promise<void>((resolve) => server.listen(path, resolve));
	const open = new Set<Socket>();
	server.on("connection", (socket) => {
		open.add(socket);
		socket.once("close", () => open.delete(socket));
	});
	cleanups.push(async () => {
		for (const socket of open) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
}

async function proxy(internalSocket: string, sealed: boolean) {
	const qa = await sandbox();
	cleanups.push(() => teardown(qa.root));
	const server = createPublicProxy({
		internalSocket,
		...(sealed ? { internalKey: key } : {}),
		clients: new ClientOccupancy(() => {}),
		admission: new HostAdmission({ protocolVersion: 1 }),
		onDetach: () => {},
	});
	await listen(server, qa.socket);
	return qa;
}

async function connect(path: string, allowHalfOpen = false): Promise<Socket> {
	const socket = createConnection({ path, allowHalfOpen });
	socket.on("error", () => {});
	cleanups.push(async () => {
		socket.destroy();
	});
	await once(socket, "connect");
	return socket;
}

const REFUSED = /host child refused a client connection/;
const RECOVERED = /host child accepts connections again after refusing 3/;

describe.skipIf(process.platform === "win32")("the supervisor's public proxy and its hop (omo#14725)", () => {
	it.each([
		["the sealed hop", true],
		["an unsealed hop (the Windows pipe shape)", false],
	])("logs a refused %s once per outage, then its recovery", async (_name, sealed) => {
		const log = supervisorLines();
		const hostRoot = await sandbox();
		cleanups.push(() => teardown(hostRoot.root));
		const internalSocket = join(hostRoot.root, "host.sock");
		const qa = await proxy(internalSocket, sealed);
		for (let index = 0; index < 3; index++) {
			const client = await connect(qa.socket);
			await once(client, "close");
		}
		expect(log.matching(REFUSED)).toHaveLength(1);
		const host = createServer((socket) => {
			socket.on("error", () => {});
			if (sealed) void acceptInternalConnection(socket, key).catch(() => socket.destroy());
		});
		await listen(host, internalSocket);
		await connect(qa.socket);
		await log.appears(RECOVERED);
		expect(log.matching(REFUSED)).toHaveLength(1);
	});

	it("delivers the reply in flight at the client's FIN through an unsealed hop, then ends the client", async () => {
		const hostRoot = await sandbox();
		cleanups.push(() => teardown(hostRoot.root));
		const internalSocket = join(hostRoot.root, "host.sock");
		const host = createServer({ allowHalfOpen: true }, (socket) => {
			socket.on("error", () => {});
			let input = "";
			socket.on("data", (chunk: Buffer) => {
				input += chunk.toString();
			});
			// The host answers only once the forwarded FIN arrived: the reply is still in flight at the client's FIN.
			socket.once("end", () => {
				const request = JSON.parse(input.trim()) as { id: string };
				socket.end(
					`${JSON.stringify({ type: "response", id: request.id, command: "list_sessions", success: true })}\n`,
				);
			});
		});
		await listen(host, internalSocket);
		const qa = await proxy(internalSocket, false);
		const client = await connect(qa.socket, true);
		let received = "";
		client.on("data", (chunk: Buffer) => {
			received += chunk.toString();
		});
		const ended = once(client, "end");
		client.end('{"id":"r","type":"list_sessions"}\n');
		await ended;
		expect(JSON.parse(received.trim())).toMatchObject({ id: "r", success: true });
	});

	it("cuts a client at the grace when the host side never ends after the client's FIN", async () => {
		const hostRoot = await sandbox();
		cleanups.push(() => teardown(hostRoot.root));
		const internalSocket = join(hostRoot.root, "host.sock");
		const forwardedFin = new Promise<void>((resolve) => {
			const host = createServer({ allowHalfOpen: true }, (socket) => {
				socket.on("error", () => {});
				socket.resume();
				socket.once("end", () => resolve());
			});
			void listen(host, internalSocket);
		});
		const qa = await proxy(internalSocket, false);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const client = await connect(qa.socket, true);
		client.resume();
		const ended = once(client, "end");
		client.end();
		await forwardedFin;
		expect(client.readableEnded).toBe(false);
		await vi.advanceTimersByTimeAsync(PEER_END_REPLY_GRACE_MS);
		await ended;
	});
});
