import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostAdmission } from "../../src/modes/rpc/host-admission.ts";
import { ClientOccupancy } from "../../src/modes/rpc/host-client-occupancy.ts";
import { closeServer, createPublicProxy, listen } from "../../src/modes/rpc/host-lifecycle-proxy.ts";
import { attachJsonlLineReader, MAX_RPC_LINE_CHARACTERS } from "../../src/modes/rpc/jsonl.ts";

const cleanups: Array<() => Promise<void>> = [];

async function proxy(holdOpen = false) {
	const dir = await mkdtemp(join(tmpdir(), "admit-"));
	const peers: Socket[] = [];
	const internalPath = join(dir, "i.sock");
	const publicPath = join(dir, "p.sock");
	const internal = createServer((peer) => {
		peers.push(peer);
		attachJsonlLineReader(peer, (line) => {
			const command = JSON.parse(line);
			if (holdOpen && command.type === "open_session") return;
			peer.write(
				`${JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: command })}\n`,
			);
		});
	});
	await listen(internal, internalPath);
	const admission = new HostAdmission({
		protocolVersion: 1,
		serverVersion: "fixture",
		capabilities: [],
		instanceId: "proxy",
	});
	const clients = new ClientOccupancy(() => {});
	const server = createPublicProxy({ internalSocket: internalPath, clients, admission, onDetach: () => {} });
	const publicPeers = new Set<Socket>();
	server.on("connection", (peer) => publicPeers.add(peer));
	await listen(server, publicPath);
	const client = createConnection(publicPath);
	const replies: Record<string, unknown>[] = [];
	attachJsonlLineReader(client, (line) => {
		replies.push(JSON.parse(line));
		client.emit("reply");
	});
	await once(client, "connect");
	cleanups.push(async () => {
		client.destroy();
		clients.destroyAll();
		for (const peer of peers) peer.destroy();
		await Promise.all([
			new Promise<void>((resolve) => server.close(() => resolve())),
			new Promise<void>((resolve) => internal.close(() => resolve())),
		]);
		await rm(dir, { recursive: true, force: true });
	});
	const take = async (count: number) => {
		const signal = AbortSignal.timeout(5_000);
		while (replies.length < count) await once(client, "reply", { signal });
		return replies.splice(0, count);
	};
	return {
		client,
		admission,
		take,
		publicPeers,
		peers,
		clients,
		server,
		publicPath,
		holdOpens: () => {
			holdOpen = true;
		},
	};
}

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.restoreAllMocks();
});

describe.skipIf(process.platform === "win32")("supervisor admission framing", () => {
	it("closes a drained connection after its last session parks", async () => {
		const p = await proxy();
		p.client.write('{"id":"open","type":"open_session"}\n');
		expect(await p.take(1)).toMatchObject([{ id: "open", success: true }]);
		const closed = once(p.client, "close", { signal: AbortSignal.timeout(2_000) });
		p.admission.stop();
		p.peers[0].end('{"type":"session_closed","sessionId":"parked","reason":"handoff_parked"}\n');
		const [records, close] = await Promise.all([p.take(1), closed]);
		expect(records).toMatchObject([{ type: "session_closed", reason: "handoff_parked" }]);
		expect(close).toEqual([false]);
		expect(p.server.listening).toBe(true);
	});

	it("does not let a late accept pin server close after client teardown", async () => {
		const p = await proxy();
		p.admission.stop();
		p.clients.destroyAll();
		const accepted = once(p.server, "connection");
		const late = createConnection(p.publicPath);
		late.on("error", () => {});
		try {
			await accepted;
			const closed = once(p.server, "close", { signal: AbortSignal.timeout(2_000) });
			void closeServer(p.server);
			await closed;
		} finally {
			late.destroy();
		}
	});

	it("bounds refusal flushing when a reader never drains", async () => {
		vi.useFakeTimers();
		try {
			const admission = new HostAdmission({});
			admission.onStop(() => new Promise<void>(() => {}));
			admission.stop();
			let flushed = false;
			const flush = admission.flush().then(() => {
				flushed = true;
			});
			await vi.advanceTimersByTimeAsync(1_999);
			expect(flushed).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
			await flush;
			expect(flushed).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("keeps control commands flowing while multiple opens are pending", async () => {
		const p = await proxy(true);
		p.client.write(
			'{"id":"first","type":"open_session"}\n{"id":"second","type":"open_session"}\n{"id":"control","type":"echo"}\n',
		);
		expect(await p.take(1)).toMatchObject([{ id: "control", success: true }]);
		p.admission.stop();
		expect(await p.take(2)).toMatchObject([
			{ id: "first", errorCode: "host_stopping" },
			{ id: "second", errorCode: "host_stopping" },
		]);
	});

	it("rearms reply filtering for later opens on an already admitted connection", async () => {
		const p = await proxy();
		p.client.write('{"id":"first","type":"open_session"}\n');
		expect(await p.take(1)).toMatchObject([{ id: "first", success: true }]);
		p.holdOpens();
		p.client.write('{"id":"second","type":"open_session"}\n{"id":"barrier","type":"echo"}\n');
		expect(await p.take(1)).toMatchObject([{ id: "barrier" }]);
		p.admission.stop();
		expect(await p.take(1)).toMatchObject([{ id: "second", errorCode: "host_stopping" }]);
		p.peers[0].write(
			'{"type":"response","command":"open_session","id":"second","success":true}\n{"type":"event","name":"after-refused"}\n',
		);
		expect(await p.take(1)).toEqual([{ type: "event", name: "after-refused" }]);
	});

	it("preserves fragmented UTF-8, LF framing, and pipelined FIFO", async () => {
		const p = await proxy();
		const first = Buffer.from(`${JSON.stringify({ id: "one", type: "echo", text: "한\u2028글" })}\n`);
		const split = first.indexOf(Buffer.from("한")) + 1;
		p.client.write(first.subarray(0, split));
		p.client.write(Buffer.concat([first.subarray(split), Buffer.from('{"id":"two","type":"echo"}\n')]));
		expect(await p.take(2)).toMatchObject([
			{ id: "one", data: { text: "한\u2028글" } },
			{ id: "two", data: { id: "two" } },
		]);
	});

	it("resynchronizes after an oversized command and still answers the next record", async () => {
		const p = await proxy();
		p.client.write(`${"x".repeat(MAX_RPC_LINE_CHARACTERS + 1)}\n{"id":"next","type":"echo"}\n`);
		expect(await p.take(2)).toMatchObject([
			{ command: "parse", success: false },
			{ id: "next", success: true },
		]);
	});

	it("checks admission after a fragmented request began while ready", async () => {
		const p = await proxy();
		p.client.write('{"id":"late","type":"open_');
		p.admission.stop();
		p.client.write('session"}\n{"id":"info","type":"get_protocol_info"}\n');
		expect(await p.take(2)).toMatchObject([
			{ id: "late", errorCode: "host_stopping" },
			{ id: "info", data: { lifecycle: "stopping" } },
		]);
	});

	it("keeps whole response records when stopping races outbound backpressure", async () => {
		const p = await proxy();
		let blocked!: () => void;
		const backpressure = new Promise<void>((resolve) => {
			blocked = resolve;
		});
		const write = p.client.write;
		// Observe the real socket's return value; do not manufacture backpressure.
		vi.spyOn(Socket.prototype, "write").mockImplementation(function (
			this: Socket,
			...args: Parameters<Socket["write"]>
		) {
			const accepted = write.apply(this, args);
			if (p.publicPeers.has(this) && !accepted) blocked();
			return accepted;
		});
		p.client.pause();
		p.client.write(`${JSON.stringify({ id: "large", type: "echo", text: "x".repeat(4 * 1024 * 1024) })}\n`);
		await backpressure;
		p.admission.stop();
		p.client.write('{"id":"late","type":"open_session"}\n');
		p.client.resume();
		const replies = await p.take(2);
		expect(replies.map((reply) => reply.id)).toEqual(["large", "late"]);
		expect(replies[1]).toMatchObject({ errorCode: "host_stopping" });
		expect(replies[0].success).toBe(true);
	});
});
