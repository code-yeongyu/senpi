import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostAdmission, type HostSessionCensus } from "../../src/modes/rpc/host-admission.ts";
import { ClientOccupancy } from "../../src/modes/rpc/host-client-occupancy.ts";
import { closeServer, createPublicProxy, listen } from "../../src/modes/rpc/host-lifecycle-proxy.ts";
import { attachJsonlLineReader, MAX_RPC_LINE_CHARACTERS } from "../../src/modes/rpc/jsonl.ts";

const cleanups: Array<() => Promise<void>> = [];

async function proxy(holdOpen = false, publicSecret?: Buffer, census?: HostSessionCensus) {
	const dir = await mkdtemp(join(tmpdir(), "admit-"));
	const peers: Socket[] = [];
	const internalLines: string[] = [];
	const internalPath = join(dir, "i.sock");
	const publicPath = join(dir, "p.sock");
	const internal = createServer((peer) => {
		peers.push(peer);
		attachJsonlLineReader(peer, (line) => {
			internalLines.push(line);
			const command = JSON.parse(line);
			if (command.type === "launch_proven") return;
			if (holdOpen && command.type === "open_session") return;
			peer.write(
				`${JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: command })}\n`,
			);
		});
	});
	await listen(internal, internalPath);
	const admission = new HostAdmission(
		{
			protocolVersion: 1,
			serverVersion: "fixture",
			capabilities: [],
			instanceId: "proxy",
		},
		census,
	);
	const clients = new ClientOccupancy(() => {});
	const server = createPublicProxy({
		internalSocket: internalPath,
		clients,
		admission,
		onDetach: () => {},
		...(publicSecret ? { publicSecret } : {}),
	});
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
		internalLines,
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
	// senpi#5632 (CI on senpi#5651): a client that proved the public secret (the Windows path) gets its first request
	// forwarded behind the proof record; the record must not delay reading the client past its resume.
	it("forwards a secret-proven client's first request right behind the launch proof", async () => {
		const secret = Buffer.alloc(32, 7);
		const p = await proxy(false, secret);
		p.client.write(Buffer.concat([secret, Buffer.from('{"id":"first","type":"get_protocol_info"}\n')]));
		expect(await p.take(1)).toMatchObject([{ id: "first", command: "get_protocol_info", success: true }]);
		expect(p.internalLines.map((line) => JSON.parse(line).type)).toEqual(["launch_proven", "get_protocol_info"]);
	});

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

	// senpi#7132: a client accepted after the stop has no hop; the census answers its listing, nothing else gets through.
	it("answers a late client's list_sessions from the census and refuses everything else", async () => {
		const asked: unknown[] = [];
		let answer: Record<string, unknown> | undefined = {
			type: "response",
			id: "census-1",
			command: "list_sessions",
			success: true,
			data: { sessions: [{ sessionId: "live" }] },
		};
		const p = await proxy(false, undefined, async (request) => {
			asked.push(request);
			return answer;
		});
		p.admission.stop();
		const late = createConnection(p.publicPath);
		const replies: Record<string, unknown>[] = [];
		attachJsonlLineReader(late, (line) => {
			replies.push(JSON.parse(line));
			late.emit("reply");
		});
		cleanups.push(async () => {
			late.destroy();
		});
		await once(late, "connect");
		const take = async (count: number) => {
			const signal = AbortSignal.timeout(5_000);
			while (replies.length < count) await once(late, "reply", { signal });
			return replies.splice(0, count);
		};
		late.write(
			'{"id":"list","type":"list_sessions","include_workers":true,"hold_host":true}\n{"id":"prompt","type":"prompt"}\n',
		);
		expect(await take(2)).toMatchObject([
			{ id: "list", command: "list_sessions", success: true, data: { sessions: [{ sessionId: "live" }] } },
			{ id: "prompt", errorCode: "host_stopping" },
		]);
		expect(asked).toEqual([{ id: "list", type: "list_sessions", include_workers: true, hold_host: true }]);
		answer = undefined;
		late.write('{"id":"unanswered","type":"list_sessions"}\n');
		expect(await take(1)).toMatchObject([{ id: "unanswered", errorCode: "host_stopping" }]);
		expect(p.internalLines).toEqual([]);
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

// senpi#7388: a public client whose connection to the host fails used to be reset before any reply. The proxy runs in a
// child so the test reads what the supervisor really writes to fd 2 (a detached daemon's only diagnostic channel).
describe.skipIf(process.platform === "win32")("a failed connection to the host", () => {
	const fixture = join(import.meta.dirname, "../fixtures/hop-failure-proxy.ts");

	it.each([
		["fails its handshake", "keyed"],
		["finds no listener (a hop without an internal key)", "keyless"],
	])("refuses every client with host_unavailable and logs the outage once when the connection %s", async (_, mode) => {
		const child = spawn(process.execPath, [fixture, mode], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		const [code] = await once(child, "close");

		expect(code).toBe(0);
		const replies = stdout
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(replies).toMatchObject(
			["open-1", "open-2"].map((id) => ({
				id,
				command: "open_session",
				success: false,
				errorCode: "host_unavailable",
				errorData: { reason: "internal_connection_failed" },
			})),
		);
		const lines = stderr.split("\n").filter((line) => line.startsWith("senpi rpc host supervisor:"));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("connection to the host failed");
	});
});

// senpi#7425: a connection refused with host_unavailable stays open to read its refusals, but it can never reach the
// host, so it must not count as attached occupancy and hold the supervisor's idle exit. A working hop still counts.
describe.skipIf(process.platform === "win32")("occupancy of a refused connection", () => {
	it.each([
		["a refused connection does not", false, 0],
		["a connection that reached the host does", true, 1],
	])("%s count as attached occupancy while it stays connected", async (_, hostListens, expected) => {
		const dir = await mkdtemp(join(tmpdir(), "refused-occ-"));
		const internalPath = join(dir, "i.sock");
		const publicPath = join(dir, "p.sock");
		const internal = hostListens
			? createServer((peer) =>
					attachJsonlLineReader(peer, (line) => {
						const command = JSON.parse(line);
						peer.write(
							`${JSON.stringify({ type: "response", id: command.id, command: command.type, success: true })}\n`,
						);
					}),
				)
			: undefined;
		if (internal) await listen(internal, internalPath);
		const clients = new ClientOccupancy(() => {});
		const server = createPublicProxy({
			internalSocket: internalPath,
			clients,
			admission: new HostAdmission({
				protocolVersion: 1,
				serverVersion: "fixture",
				capabilities: [],
				instanceId: "occ",
			}),
			onDetach: () => {},
		});
		await listen(server, publicPath);
		const client = createConnection(publicPath);
		cleanups.push(async () => {
			client.destroy();
			clients.destroyAll();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			if (internal) await new Promise<void>((resolve) => internal.close(() => resolve()));
			await rm(dir, { recursive: true, force: true });
		});
		const reply = new Promise<Record<string, unknown>>((resolve) =>
			attachJsonlLineReader(client, (line) => resolve(JSON.parse(line))),
		);
		await once(client, "connect");
		client.write(`${JSON.stringify({ id: "open-1", type: "open_session", cwd: dir })}\n`);

		expect((await reply).success).toBe(hostListens);
		expect(client.destroyed).toBe(false);
		expect(clients.attachedCount).toBe(expected);
		expect(clients.occupancy(undefined)).toBe(expected);
		expect(clients.unclassifiedCount).toBe(0);
	});
});
