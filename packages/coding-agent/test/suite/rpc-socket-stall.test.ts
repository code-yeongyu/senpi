import { expect, it, vi } from "vitest";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { SESSION_WORKER_LIMITS } from "../../src/modes/rpc/session-worker-protocol.ts";
import {
	DEFAULT_STALL_MS,
	SocketEventQueueStallError,
	SocketEventSinkActor,
} from "../../src/modes/rpc/socket-event-fanout.ts";

// A stalled peer must be cut before the producing worker's credit deadline, or
// the host quarantines a healthy session (session_worker_credit_timeout).
it("cuts a stalled socket peer before the worker credit deadline", () => {
	expect(DEFAULT_STALL_MS).toBeLessThan(SESSION_WORKER_LIMITS.controlMs);
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

it("returns session credit and disconnects only the stalled peer", async () => {
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
		// The worker's credit return waits on every destination of the session.
		let credited = false;
		const credit = writer.waitForSessionBackpressure("rpc-1").then(
			() => (credited = true),
			() => (credited = true),
		);
		await vi.advanceTimersByTimeAsync(49);
		expect(credited).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		await credit;
		expect(credited).toBe(true);
		expect(closed).toEqual(["a"]);
		expect(a.at(-1)).toBe('{"type":"overflow","error":"stalled, resync required"}\n');
		expect(b).toHaveLength(1);
		expect(JSON.parse(b[0]!)).toMatchObject({ type: "message_update", sessionId: "rpc-1" });
		// A later record for the session no longer waits on the cut peer.
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
