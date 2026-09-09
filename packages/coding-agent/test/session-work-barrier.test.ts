import { describe, expect, it } from "vitest";
import { SessionWorkBarrier } from "../src/core/session-work-barrier.ts";

/**
 * `waitForSettled` re-samples the event queue until two consecutive samples agree.
 * A session whose queue identity is replaced by already-resolved promises never
 * reaches agreement, and because every iteration only awaits microtasks the loop
 * never yields to the event loop's timer/IO phases: the process pins one core at
 * 100% CPU for as long as the producer keeps re-chaining. This is the observed
 * `omo --mode rpc --multi-session` child spin.
 */
describe("SessionWorkBarrier.waitForSettled", () => {
	it("returns once the event queue identity is stable and no work is active", async () => {
		const barrier = new SessionWorkBarrier();
		const queue = Promise.resolve();
		await barrier.waitForSettled(() => queue);
		expect(barrier.hasActiveWork).toBe(false);
	});

	it("waits for active work registered through begin()", async () => {
		const barrier = new SessionWorkBarrier();
		const queue = Promise.resolve();
		const finish = barrier.begin();
		expect(barrier.hasActiveWork).toBe(true);

		let settled = false;
		const waiter = barrier
			.waitForSettled(() => queue)
			.then(() => {
				settled = true;
			});

		await Promise.resolve();
		expect(settled).toBe(false);

		finish();
		await waiter;
		expect(settled).toBe(true);
		expect(barrier.hasActiveWork).toBe(false);
	});

	it("keeps the event loop responsive when the queue never stabilizes", async () => {
		const barrier = new SessionWorkBarrier();
		// Model the observed spin: a session whose subscriber keeps re-chaining an
		// already-resolved queue, so the two samples in one round never agree.
		// Awaiting only such promises never leaves the microtask queue, which pins
		// a core at 100% CPU and stalls every timer and socket on the process.
		let unstableRounds = 0;
		const getEventQueue = (): Promise<void> => {
			unstableRounds++;
			return Promise.resolve();
		};

		let timerFired = false;
		const ticker = setInterval(() => {
			timerFired = true;
		}, 1);
		// Deliberately not awaited: an unstable queue means there is still work to
		// drain, so reporting it as settled would be a lie. The contract under test
		// is that waiting stays cheap, not that it gives up.
		void barrier.waitForSettled(getEventQueue);

		try {
			await new Promise<void>((resolve) => {
				const deadline = setTimeout(resolve, 50);
				deadline.unref?.();
			});
			// A starving loop never lets these timers run at all.
			expect(timerFired).toBe(true);
			expect(unstableRounds).toBeGreaterThan(0);
		} finally {
			clearInterval(ticker);
		}
	});
});
