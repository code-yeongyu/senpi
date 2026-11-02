import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { DEFAULT_STALL_MS } from "../../src/modes/rpc/socket-event-fanout.ts";
import { socketSink } from "../../src/modes/rpc/socket-sink.ts";

/** The bounded window a cut peer has to read its notice before the socket is destroyed. */
const CUT_GRACE_MS = 5_000;
// Larger than any socket buffer: the kernel takes a few KiB and the remainder stays in
// this socket's userspace buffer, which is what made the notice unobservable before.
const BLOCKING_RECORD = "x".repeat(4 * 1024 * 1024);

type Pair = { host: Socket; peer: Socket; dispose: () => Promise<void> };

/** A real unix socket pair whose client end stays paused: a peer that stopped reading. */
async function socketPair(): Promise<Pair> {
	const directory = await mkdtemp(join(tmpdir(), "senpi-rpc-cut-"));
	const path = join(directory, "rpc.sock");
	const accepted = Promise.withResolvers<Socket>();
	const server = createServer((socket) => accepted.resolve(socket));
	await new Promise<void>((resolve) => void server.listen(path, resolve));
	const peer = createConnection(path);
	await new Promise<void>((resolve, reject) => {
		peer.once("connect", () => resolve());
		peer.once("error", reject);
	});
	return {
		host: await accepted.promise,
		peer,
		dispose: async () => {
			peer.destroy();
			await new Promise<void>((resolve) => void server.close(() => resolve()));
			await rm(directory, { recursive: true, force: true });
		},
	};
}

/** Everything the peer reads once it resumes, terminated by the host's EOF. */
function readUntilEof(peer: Socket): Promise<string> {
	const chunks: Buffer[] = [];
	return new Promise<string>((resolve, reject) => {
		peer.on("data", (chunk: Buffer) => void chunks.push(chunk));
		peer.once("end", () => resolve(Buffer.concat(chunks).toString()));
		peer.once("error", reject);
	});
}

function registerPeer(host: Socket, options: { readonly maxQueueBytes?: number } = {}): SessionEventWriter {
	const writer = new SessionEventWriter(() => {});
	writer.registerConnection("peer", socketSink(host), options);
	writer.attachConnectionToSession("peer", "rpc-1");
	return writer;
}

it("delivers the stall notice before EOF to a peer that resumes inside the cut grace", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const pair = await socketPair();
	try {
		const writer = registerPeer(pair.host);
		expect(writer.enqueue("rpc-1", { type: "message_update", text: BLOCKING_RECORD })).toBe(true);
		await vi.advanceTimersByTimeAsync(DEFAULT_STALL_MS - 1);
		expect(pair.host.writableEnded).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		// The cut is a graceful half-close, so the notice is still deliverable.
		expect(pair.host.writableEnded).toBe(true);
		expect(pair.host.destroyed).toBe(false);
		// The peer resumes one second after the cut decision, inside the grace.
		await vi.advanceTimersByTimeAsync(1_000);
		expect(pair.host.destroyed).toBe(false);
		const received = await readUntilEof(pair.peer);
		const lines = received.split("\n").filter((line) => line.length > 0);
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0])).toMatchObject({ type: "message_update", sessionId: "rpc-1" });
		expect(JSON.parse(lines[1])).toEqual({ type: "overflow", error: "stalled, resync required" });
	} finally {
		vi.useRealTimers();
		await pair.dispose();
	}
});

it("delivers the byte-overflow notice before EOF to a peer that resumes inside the cut grace", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const pair = await socketPair();
	try {
		const writer = registerPeer(pair.host, { maxQueueBytes: 512 * 1024 });
		// The first record is written and blocks; the next two exceed the queue bound.
		expect(writer.enqueue("rpc-1", { type: "message_update", text: "a".repeat(400 * 1024) })).toBe(true);
		expect(writer.enqueue("rpc-1", { type: "message_update", text: "b".repeat(400 * 1024) })).toBe(true);
		expect(writer.enqueue("rpc-1", { type: "message_update", text: "c".repeat(200 * 1024) })).toBe(true);
		expect(pair.host.writableEnded).toBe(true);
		expect(pair.host.destroyed).toBe(false);
		const received = await readUntilEof(pair.peer);
		const lines = received.split("\n").filter((line) => line.length > 0);
		// Fail-closed: the queued remainder is dropped, but the notice explaining it is not.
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0]).text).toBe("a".repeat(400 * 1024));
		expect(JSON.parse(lines[1])).toEqual({ type: "overflow", error: "overflow, resync required" });
	} finally {
		vi.useRealTimers();
		await pair.dispose();
	}
});

it("destroys a cut peer that never resumes once the grace expires", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const pair = await socketPair();
	try {
		const writer = registerPeer(pair.host);
		expect(writer.enqueue("rpc-1", { type: "message_update", text: BLOCKING_RECORD })).toBe(true);
		await vi.advanceTimersByTimeAsync(DEFAULT_STALL_MS);
		expect(pair.host.destroyed).toBe(false);
		await vi.advanceTimersByTimeAsync(CUT_GRACE_MS - 1);
		expect(pair.host.destroyed).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(pair.host.destroyed).toBe(true);
	} finally {
		vi.useRealTimers();
		await pair.dispose();
	}
});
