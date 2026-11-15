// senpi#5898 (#6782 review L1, L3): a waiting loop-hook call's bound restarts only when a call ahead of it actually
// settles, never when a call ahead merely leaves (timed out or cancelled while it waited), and entering a session's
// queue costs the same however long the queue is.
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

describe("loop-hook session queue (senpi#5898)", () => {
	it.each([
		[
			"times out",
			async (_middle: AbortController): Promise<number> => {
				await vi.advanceTimersByTimeAsync(400);
				return 400;
			},
		],
		[
			"is cancelled",
			async (middle: AbortController): Promise<number> => {
				await vi.advanceTimersByTimeAsync(100);
				middle.abort();
				return 100;
			},
		],
	] as const)(
		"a middle call that %s while it waits does not restart the bound of the call behind it",
		async (_case, endMiddle) => {
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

			expect(await middle.ready).not.toBe("turn");
			expect(last).toBe("queue_timeout");
		},
	);

	it("enters a stuck session's queue in constant work per call, however many calls are already waiting", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const workToEnter = (calls: number): number => {
			const enter = createLoopHookSessionQueues();
			return promisesCreatedDuring(() => {
				for (let index = 0; index < calls; index++) enter("stuck", new AbortController().signal, CAP_MS);
			});
		};

		const small = workToEnter(50);
		const large = workToEnter(200);

		// Linear: four times the calls cost about four times the work (a copy per call would cost about sixteen times).
		expect(large / small).toBeLessThan(5);
	});
});
