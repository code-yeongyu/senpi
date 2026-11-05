import { afterEach, expect, it, vi } from "vitest";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";

// RULING-124 (#5322): the engine's close after a compact peer's event queue fails (session-event-fanout.ts) writes one
// `socket_closing` record after the queue's own notice, waits a bounded time for it to drain, and closes regardless;
// a broken transport closes without waiting, and a legacy or flag-off peer's bytes and close are exactly main's.

const FLAG = "SENPI_ENGINE_SOCKET_COMPACT_UPDATES";
const OVERFLOW = '{"type":"overflow","error":"overflow, resync required"}\n';
/** RULING-124 (a): the bound on the drain wait for `socket_closing`, as documented in docs/rpc.md. */
const FLUSH_MS = 1_000;

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

interface Peer {
	readonly writes: string[];
	/** How many lines the peer had received when each close ran. */
	readonly closes: number[];
	readonly closed: Promise<void>;
	drain(): void;
}

/** A peer that never keeps up until `drain()`; `broken` makes every drain reject and every later write throw. */
function stalledPeer(writer: SessionEventWriter, compact: boolean, broken = false): Peer {
	const writes: string[] = [];
	const closes: number[] = [];
	const closed = Promise.withResolvers<void>();
	const pending: (() => void)[] = [];
	let failed = false;
	writer.registerConnection(
		"peer",
		{
			writeRaw: (chunk) => {
				if (failed) throw Object.assign(new Error("write after EPIPE"), { code: "EPIPE" });
				writes.push(chunk);
			},
			waitForBackpressure: () => {
				if (!broken) return new Promise<void>((resolve) => void pending.push(resolve));
				failed = true;
				return Promise.reject(Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
			},
			close: () => {
				closes.push(writes.length);
				closed.resolve();
			},
		},
		{ maxQueueBytes: 1024 },
	);
	if (compact) writer.setConnectionCapabilities("peer", ["compact_events"]);
	writer.attachConnectionToSession("peer", "rpc-1");
	return { writes, closes, closed: closed.promise, drain: () => pending.splice(0).forEach((resolve) => resolve()) };
}

/** One record in flight to a peer that is not reading, then one past the 1 KiB queue: the overflow cut. */
function overflow(writer: SessionEventWriter): void {
	writer.enqueue("rpc-1", { type: "message_start", message: { role: "assistant", content: [] } });
	writer.enqueue("rpc-1", {
		type: "tool_execution_end",
		toolCallId: "t1",
		result: { content: [{ type: "image", data: "x".repeat(2048) }] },
	});
}

const closing = (detail: string) => ({ type: "socket_closing", code: "event_queue_failed", retryable: true, detail });

it("RULING-124 (d) a compact peer's queue overflow: socket_closing follows the overflow notice and precedes the close", async () => {
	vi.stubEnv(FLAG, "1");
	const writer = new SessionEventWriter(() => {});
	const peer = stalledPeer(writer, true);
	overflow(writer);
	expect(peer.writes.at(-2)).toBe(OVERFLOW);
	expect(JSON.parse(peer.writes.at(-1) ?? "null")).toEqual(closing("overflow"));
	expect(peer.closes, "the close waits for socket_closing to drain").toEqual([]);
	peer.drain();
	await peer.closed;
	expect(peer.closes).toEqual([peer.writes.length]);
});

it("RULING-124 (a) a peer that never drains socket_closing is closed once the bounded wait expires", async () => {
	vi.useFakeTimers();
	vi.stubEnv(FLAG, "1");
	const writer = new SessionEventWriter(() => {});
	const peer = stalledPeer(writer, true);
	overflow(writer);
	await vi.advanceTimersByTimeAsync(FLUSH_MS - 1);
	expect(peer.closes).toEqual([]);
	await vi.advanceTimersByTimeAsync(1);
	expect(peer.closes).toEqual([peer.writes.length]);
	expect(JSON.parse(peer.writes.at(-1) ?? "null")).toEqual(closing("overflow"));
});

it("RULING-124 (a) a broken transport closes without waiting: the failed drain, then the throwing write", async () => {
	vi.useFakeTimers();
	vi.stubEnv(FLAG, "1");
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	const writer = new SessionEventWriter(() => {});
	const peer = stalledPeer(writer, true, true);
	writer.enqueue("rpc-1", { type: "message_start", message: { role: "assistant", content: [] } });
	// No timer runs: the close settles on the transport's own failure, never on the bound.
	await peer.closed;
	expect(peer.closes).toHaveLength(1);
	expect(peer.writes.some((line) => line.includes("socket_closing"))).toBe(false);
});

it("RULING-124 flag-off and flag-on legacy peers: overflow bytes and the synchronous close are unchanged", () => {
	const legacy = (flag: boolean) => {
		if (flag) vi.stubEnv(FLAG, "1");
		const writer = new SessionEventWriter(() => {});
		const peer = stalledPeer(writer, false);
		overflow(writer);
		return { writes: [...peer.writes], closes: [...peer.closes] };
	};
	const off = legacy(false);
	const on = legacy(true);
	expect(off.writes.at(-1)).toBe(OVERFLOW);
	expect(off.closes, "closed synchronously, after the notice").toEqual([off.writes.length]);
	expect(on).toEqual(off);
});
