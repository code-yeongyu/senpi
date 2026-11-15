// senpi#5898 (#6782 review L1, L3): a waiting loop-hook call's bound restarts only when a call ahead of it actually
// settles, never when a call ahead merely leaves (timed out or cancelled while it waited), and entering a session's
// queue fans out to no earlier entry: a call waits on the session's one tail, never on a list of the calls ahead.
import { createHook } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoopHookSessionQueues, type LoopHookTurnOutcome } from "../../src/execution/loop-hook-session-queue.ts";

const CAP_MS = 1_000;

afterEach(() => {
	vi.useRealTimers();
});

/** Counts the promises created while `run` runs synchronously: the work a call does to enter the queue. */
function promisesCreatedDuring(run: () => void): number {
	let created = 0;
	const hook = createHook({
		init: (_asyncId, type) => {
			if (type === "PROMISE") created++;
		},
	});
	hook.enable();
	try {
		run();
	} finally {
		hook.disable();
	}
	return created;
}

/** The most entries any `Promise` combinator was handed while `run` ran synchronously (a list copied per call shows here). */
function widestCombinatorDuring(run: () => void): number {
	let widest = 0;
	const spies = (["all", "allSettled", "any", "race"] as const).map((name) => vi.spyOn(Promise, name));
	try {
		run();
		for (const spy of spies)
			for (const [entries] of spy.mock.calls)
				widest = Math.max(widest, Array.from(entries as Iterable<unknown>).length);
	} finally {
		for (const spy of spies) spy.mockRestore();
	}
	return widest;
}

describe("loop-hook session queue (senpi#5898)", () => {
	it.each([
		[
			"times out",
			"queue_timeout",
			async (_middle: AbortController): Promise<number> => {
				await vi.advanceTimersByTimeAsync(400);
				return 400;
			},
		],
		[
			"is cancelled",
			"cancelled",
			async (middle: AbortController): Promise<number> => {
				await vi.advanceTimersByTimeAsync(100);
				middle.abort();
				return 100;
			},
		],
	] as const)(
		"a middle call that %s while it waits does not restart the bound of the call behind it",
		async (_case, middleOutcome, endMiddle) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const enter = createLoopHookSessionQueues();
			// The first call holds its turn and never leaves: it is stuck.
			enter("A", new AbortController().signal, CAP_MS);
			const middleCall = new AbortController();
			const middle = enter("A", middleCall.signal, CAP_MS);
			await vi.advanceTimersByTimeAsync(600);
			let last: LoopHookTurnOutcome | undefined;
			void enter("A", new AbortController().signal, CAP_MS).ready.then((outcome) => {
				last = outcome;
			});

			const elapsed = 600 + (await endMiddle(middleCall));
			middle.leave();
			// The last call arrived at 600 ms; with nothing ahead settling, its bound ends at 1600 ms, never later.
			await vi.advanceTimersByTimeAsync(1_600 - elapsed);

			expect(await middle.ready).toBe(middleOutcome);
			expect(last).toBe("queue_timeout");
		},
	);

	it("entering a stuck session's queue fans out to no earlier entry: one tail, not a list of the calls ahead", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const arrivals = (calls: number) => {
			const enter = createLoopHookSessionQueues();
			return () => {
				for (let index = 0; index < calls; index++) enter("stuck", new AbortController().signal, CAP_MS);
			};
		};

		const small = promisesCreatedDuring(arrivals(50));
		const large = promisesCreatedDuring(arrivals(200));
		const widest = widestCombinatorDuring(arrivals(200));

		// No per-entry promise fan-out: four times the calls create about four times the promises (sixteen if each call
		// chained on every call ahead). No combinator ever gathers the calls ahead: each call waits on one tail.
		expect(large / small).toBeLessThan(5);
		expect(widest).toBeLessThanOrEqual(1);
	});
});
