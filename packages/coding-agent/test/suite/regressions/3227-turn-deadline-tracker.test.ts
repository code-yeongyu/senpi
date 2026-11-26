import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	AgentDeadlineTracker,
	buildDeadlineStopNotice,
	type DeadlineSessionOwner,
	TURN_DEADLINE_GRACE_MS,
	type TurnDeadline,
} from "../../../src/core/turn-deadline.ts";

interface FakeOwner extends DeadlineSessionOwner {
	isRetryInFlight: boolean;
	isIdle: boolean;
	readonly stops: TurnDeadline[];
	readonly warnings: string[];
	aborts: number;
	/** Extension handler waits holding the turn; releasing them lets the aborted run settle (senpi#3650). */
	heldHandlers: number;
	/** Ends the aborted run, as the agent loop does once every tool saw the abort signal. */
	settleAbort(): void;
}

function fakeOwner(): FakeOwner {
	let settle: () => void = () => {};
	const owner: FakeOwner = {
		isRetryInFlight: false,
		isIdle: false,
		stops: [],
		warnings: [],
		aborts: 0,
		heldHandlers: 0,
		releaseHeldExtensionHandlers: () => {
			const released = owner.heldHandlers;
			owner.heldHandlers = 0;
			if (released > 0) settle();
			return released;
		},
		_recordDeadlineStop: (deadline) => owner.stops.push(deadline),
		abortTurnForDeadline: () => {
			owner.aborts += 1;
			return new Promise<void>((resolve) => {
				settle = () => {
					owner.isIdle = true;
					resolve();
				};
			});
		},
		_warnDeadline: (event) => owner.warnings.push(event),
		settleAbort: () => settle(),
	};
	return owner;
}

describe("turn deadline tracker (senpi#3227 review)", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("records the stop and aborts the turn; a turn that settles within the grace reports nothing", async () => {
		const owner = fakeOwner();
		const tracker = new AgentDeadlineTracker(owner, () => ({ inactivityMs: 60_000, maxRuntimeMs: 0 }));
		tracker.arm();

		await vi.advanceTimersByTimeAsync(60_000);
		expect(owner.stops).toEqual([{ kind: "inactivity", limitMs: 60_000, elapsedMs: 60_000 }]);
		expect(owner.aborts).toBe(1);

		owner.settleAbort();
		await vi.advanceTimersByTimeAsync(TURN_DEADLINE_GRACE_MS);
		expect(owner.warnings).toEqual([]);
	});

	it("reports a turn neither the abort nor the handler release can end, after both graces, instead of faking idle", async () => {
		const owner = fakeOwner();
		const tracker = new AgentDeadlineTracker(owner, () => ({ inactivityMs: 60_000, maxRuntimeMs: 0 }));
		tracker.arm();

		await vi.advanceTimersByTimeAsync(60_000 + 2 * TURN_DEADLINE_GRACE_MS - 1);
		expect(owner.warnings).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);

		expect(owner.isIdle).toBe(false);
		expect(owner.warnings).toEqual(["turn_deadline_unsettled"]);
	});

	it("releases extension handlers holding the turn after the grace, so the turn settles without a report (senpi#3650)", async () => {
		// given a turn held by an extension handler that the abort alone cannot end
		const owner = fakeOwner();
		owner.heldHandlers = 1;
		const tracker = new AgentDeadlineTracker(owner, () => ({ inactivityMs: 60_000, maxRuntimeMs: 0 }));
		tracker.arm();

		// when the lease fires and the first grace runs out
		await vi.advanceTimersByTimeAsync(60_000 + TURN_DEADLINE_GRACE_MS);
		await vi.advanceTimersByTimeAsync(TURN_DEADLINE_GRACE_MS);

		// then the held handler was released, the turn settled, and nothing was reported as unsettled
		expect(owner.heldHandlers).toBe(0);
		expect(owner.isIdle).toBe(true);
		expect(owner.warnings).toEqual([]);
	});

	it("keeps a stopped, unsettled run's deadline when the user steers into it", async () => {
		const owner = fakeOwner();
		const tracker = new AgentDeadlineTracker(owner, () => ({ inactivityMs: 60_000, maxRuntimeMs: 0 }));
		tracker.arm();
		await vi.advanceTimersByTimeAsync(60_000);

		tracker.clearHold();
		await vi.advanceTimersByTimeAsync(60_000);

		expect(tracker.current).toMatchObject({ kind: "inactivity" });
		expect(owner.stops).toHaveLength(1);
	});

	it("keeps the inactivity lease through a provider retry and fires once the retry is over", async () => {
		const owner = fakeOwner();
		const tracker = new AgentDeadlineTracker(owner, () => ({ inactivityMs: 60_000, maxRuntimeMs: 0 }));
		tracker.arm();
		owner.isRetryInFlight = true;

		await vi.advanceTimersByTimeAsync(60_000);
		expect(owner.stops).toEqual([]);

		owner.isRetryInFlight = false;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(owner.stops).toMatchObject([{ kind: "inactivity", elapsedMs: 120_000 }]);
	});

	it("applies the max-runtime cap even while a provider retry is in flight", async () => {
		const owner = fakeOwner();
		const tracker = new AgentDeadlineTracker(owner, () => ({ inactivityMs: 0, maxRuntimeMs: 300_000 }));
		tracker.arm();
		owner.isRetryInFlight = true;

		await vi.advanceTimersByTimeAsync(300_000);

		expect(owner.stops).toEqual([{ kind: "max_runtime", limitMs: 300_000, elapsedMs: 300_000 }]);
	});

	it("does not reset the max-runtime clock when input is steered into a live run", async () => {
		const owner = fakeOwner();
		const tracker = new AgentDeadlineTracker(owner, () => ({ inactivityMs: 0, maxRuntimeMs: 300_000 }));
		tracker.arm();
		await vi.advanceTimersByTimeAsync(200_000);

		tracker.clearHold();
		await vi.advanceTimersByTimeAsync(100_000);

		expect(owner.stops).toMatchObject([{ kind: "max_runtime", elapsedMs: 300_000 }]);
	});

	it("still stops the turn when the stop-entry write fails, and reports the failed write", async () => {
		const owner = fakeOwner();
		owner._recordDeadlineStop = () => {
			throw new Error("session refused the write");
		};
		const tracker = new AgentDeadlineTracker(owner, () => ({ inactivityMs: 60_000, maxRuntimeMs: 0 }));
		tracker.arm();

		await vi.advanceTimersByTimeAsync(60_000);

		expect(owner.warnings).toEqual(["turn_deadline_record_failed"]);
		expect(owner.aborts).toBe(1);
		expect(tracker.current).toMatchObject({ kind: "inactivity" });
	});

	it("shows a sub-minute limit in seconds", () => {
		expect(buildDeadlineStopNotice({ kind: "max_runtime", limitMs: 20_000, elapsedMs: 20_000 })).toMatch(/20 s/);
		expect(buildDeadlineStopNotice({ kind: "inactivity", limitMs: 3_600_000, elapsedMs: 3_600_000 })).toMatch(
			/60 min/,
		);
	});

	it("reports an abort that rejects with its own error, and a settled stop's deadline clears on the next input", async () => {
		const owner = fakeOwner();
		owner.abortTurnForDeadline = () => {
			owner.aborts += 1;
			owner.isIdle = true;
			return Promise.reject(new Error("abort exploded"));
		};
		const tracker = new AgentDeadlineTracker(owner, () => ({ inactivityMs: 60_000, maxRuntimeMs: 0 }));
		tracker.arm();

		await vi.advanceTimersByTimeAsync(60_000);
		expect(owner.warnings).toEqual(["turn_deadline_abort_failed"]);

		tracker.clearHold();
		expect(tracker.current).toBeUndefined();
	});
});
