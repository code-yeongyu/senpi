import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordLoopBlockedMs } from "../../../src/modes/rpc/loop-blocked-time.ts";
import {
	DEFAULT_STALL_MS,
	SocketEventQueueStallError,
	SocketEventSinkActor,
} from "../../../src/modes/rpc/socket-event-fanout.ts";

// senpi#1905: the dead-peer detector measured wall time. When the HOST loop blocked for
// longer than the budget, the stall timer ran before the pending drain I/O on unblock and
// cut a peer that had never been given a chance to read - every host-session child on
// that connection ended with transport_gone while its session kept running.

function stalledActor(failures: unknown[]): SocketEventSinkActor {
	const never = new Promise<void>(() => {});
	return new SocketEventSinkActor({ writeRaw: () => {}, waitForBackpressure: () => never }, (cause) =>
		failures.push(cause),
	);
}

describe("issue 1905: the stall verdict counts loop-served time only", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("keeps a peer whose silence was the host's own blocked loop", async () => {
		// Given: a connection whose peer has not drained, and a host loop that blocked for
		// longer than the whole stall budget inside the window
		const failures: unknown[] = [];
		const actor = stalledActor(failures);
		actor.enqueue('{"a":1}\n');
		await vi.advanceTimersByTimeAsync(DEFAULT_STALL_MS / 2);
		recordLoopBlockedMs(DEFAULT_STALL_MS + 5_000);

		// When: the wall-clock deadline passes
		await vi.advanceTimersByTimeAsync(DEFAULT_STALL_MS / 2);

		// Then: the peer is not cut - it was never given served time to drain
		expect(failures).toEqual([]);

		// When: a further full budget of SERVED time passes with no drain
		await vi.advanceTimersByTimeAsync(DEFAULT_STALL_MS);

		// Then: the peer is cut as genuinely dead
		expect(failures).toHaveLength(1);
		expect(failures[0]).toBeInstanceOf(SocketEventQueueStallError);
	});

	it("still cuts a dead peer after the budget when the loop was never blocked", async () => {
		// Given: a stalled peer and a loop that served the whole window
		const failures: unknown[] = [];
		const actor = stalledActor(failures);
		actor.enqueue('{"a":1}\n');

		// When: the budget elapses
		await vi.advanceTimersByTimeAsync(DEFAULT_STALL_MS - 1);
		expect(failures).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);

		// Then: the cut lands on the budget exactly as before
		expect(failures).toHaveLength(1);
		expect(failures[0]).toBeInstanceOf(SocketEventQueueStallError);
	});
});
