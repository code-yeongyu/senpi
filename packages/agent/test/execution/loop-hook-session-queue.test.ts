// senpi#5898 (#6782 review L1, L3): a call that leaves while a call ahead of it is still stuck (it timed out or was
// cancelled while it waited) does not restart the bound of the call behind it; and 200 calls entering a stuck session's
// queue create under five times the promises that 50 calls do.
import { createHook } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLoopHookSessionQueues, type LoopHookTurnOutcome } from "../../src/execution/loop-hook-session-queue.ts";

const CAP_MS = 1_000;

afterEach(() => {
	vi.useRealTimers();
});

/** Counts the promises created while `run` runs synchronously. */
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
			// The last call arrived at 600 ms, so its own bound ends at 1600 ms. A restart when the middle call left (at 700 or
			// 1000 ms) would end it at 1700 ms or later, so it would still be waiting here.
			await vi.advanceTimersByTimeAsync(1_600 - elapsed);

			expect(await middle.ready).toBe(middleOutcome);
			expect(last).toBe("queue_timeout");
		},
	);

	it("200 calls entering a stuck session's queue create under five times the promises 50 calls do", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const promisesForArrivals = (calls: number): number => {
			const enter = createLoopHookSessionQueues();
			return promisesCreatedDuring(() => {
				for (let index = 0; index < calls; index++) enter("stuck", new AbortController().signal, CAP_MS);
			});
		};

		const small = promisesForArrivals(50);
		const large = promisesForArrivals(200);

		// Four times the calls must create under five times the promises. A queue in which each call waits on every call
		// ahead of it creates quadratically many: about thirteen times, measured against #6782's list queue.
		expect(large / small).toBeLessThan(5);
	});
});
