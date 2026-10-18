import { expect, it, vi } from "vitest";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { SESSION_WORKER_LIMITS } from "../../src/modes/rpc/session-worker-protocol.ts";
import {
	DEFAULT_STALL_MS,
	SocketEventQueueStallError,
	SocketEventSinkActor,
} from "../../src/modes/rpc/socket-event-fanout.ts";

// The stall cut is a dead-peer detector, not a credit pacer. Worker credit is returned
// when a record is accepted into each connection's bounded queue (rpc-socket-credit.test.ts),
// so this budget is a transport liveness bound and is deliberately NOT tied to the worker's
// control deadline: a client busy for a few seconds is not a dead peer.
it("budgets the dead-peer cut independently of the worker control deadline", () => {
	expect(DEFAULT_STALL_MS).toBe(30_000);
	expect(DEFAULT_STALL_MS).toBeGreaterThan(SESSION_WORKER_LIMITS.controlMs);
});

it("fails a sink whose peer never drains and keeps a draining sibling untouched", async () => {
	vi.useFakeTimers();
	try {
		const written: string[] = [];
		const failures: unknown[] = [];
		const never = new Promise<void>(() => {});
		const stalled = new SocketEventSinkActor(
			{ writeRaw: (line) => void written.push(line), waitForBackpressure: () => never },
			(cause) => failures.push(cause),
			1024 * 1024,
			50,
		);
		const healthyWritten: string[] = [];
		const healthy = new SocketEventSinkActor(
			{ writeRaw: (line) => void healthyWritten.push(line), waitForBackpressure: () => Promise.resolve() },
			(cause) => failures.push(cause),
		);
		stalled.enqueue('{"a":1}\n');
		healthy.enqueue('{"b":1}\n');
		await vi.advanceTimersByTimeAsync(49);
		expect(failures).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(failures).toHaveLength(1);
		expect(failures[0]).toBeInstanceOf(SocketEventQueueStallError);
		expect(written).toEqual(['{"a":1}\n', '{"type":"overflow","error":"stalled, resync required"}\n']);
		await expect(stalled.flush()).rejects.toBeInstanceOf(SocketEventQueueStallError);
		await healthy.flush();
		expect(healthyWritten).toEqual(['{"b":1}\n']);
	} finally {
		vi.useRealTimers();
	}
});

it("returns session credit without waiting for a drain and cuts only the dead peer", async () => {
	vi.useFakeTimers();
	try {
		const writer = new SessionEventWriter(() => {});
		const closed: string[] = [];
		const a: string[] = [];
		const b: string[] = [];
		writer.registerConnection(
			"a",
			{
				writeRaw: (line) => void a.push(line),
				waitForBackpressure: () => new Promise<void>(() => {}),
				close: () => closed.push("a"),
			},
			{ stallMs: 50 },
		);
		writer.registerConnection("b", {
			writeRaw: (line) => void b.push(line),
			waitForBackpressure: () => Promise.resolve(),
			close: () => closed.push("b"),
		});
		writer.attachConnectionToSession("a", "rpc-1");
		writer.attachConnectionToSession("b", "rpc-1");
		expect(writer.enqueue("rpc-1", { type: "message_update", text: "x" })).toBe(true);
		let credited = false;
		void writer.waitForSessionBackpressure("rpc-1").then(() => {
			credited = true;
		});
		// Both queues accepted the record, so the worker's credit is due with no clock
		// movement at all - neither peer's kernel drain is on the credit path.
		await vi.advanceTimersByTimeAsync(0);
		expect(credited).toBe(true);
		expect(closed).toEqual([]);
		// The stalled peer is still cut on its own budget, and only it.
		await vi.advanceTimersByTimeAsync(49);
		expect(closed).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		expect(closed).toEqual(["a"]);
		expect(a.at(-1)).toBe('{"type":"overflow","error":"stalled, resync required"}\n');
		expect(b).toHaveLength(1);
		expect(JSON.parse(b[0]!)).toMatchObject({ type: "message_update", sessionId: "rpc-1" });
		// A later record for the session still returns credit and still reaches the live peer.
		expect(writer.enqueue("rpc-1", { type: "message_update", text: "y" })).toBe(true);
		await writer.waitForSessionBackpressure("rpc-1");
		expect(b).toHaveLength(2);
	} finally {
		vi.useRealTimers();
	}
});

it("keeps the writer and its stdio lane alive when one socket peer stalls", async () => {
	vi.useFakeTimers();
	try {
		const stdout: string[] = [];
		const writer = new SessionEventWriter((line) => void stdout.push(line));
		const closed: string[] = [];
		writer.registerConnection(
			"stalled",
			{
				writeRaw: () => {},
				waitForBackpressure: () => new Promise<void>(() => {}),
				close: () => closed.push("stalled"),
			},
			{ stallMs: 50 },
		);
		writer.attachConnectionToSession("stalled", "rpc-1");
		expect(writer.enqueue("rpc-1", { type: "message_update", text: "x" })).toBe(true);
		// The scheduled flush aggregates every actor; the stalled one rejects.
		await vi.advanceTimersByTimeAsync(60);
		expect(closed).toEqual(["stalled"]);
		// Before the fix this rejected the writer-wide drain and failed the host writer;
		// stdio control output must still flow afterwards.
		await writer.enqueueControl({ type: "response", id: "after-stall", success: true });
		await writer.flush();
		expect(stdout.map((line) => JSON.parse(line))).toEqual([{ type: "response", id: "after-stall", success: true }]);
	} finally {
		vi.useRealTimers();
	}
});
