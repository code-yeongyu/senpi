import { describe, expect, it, vi } from "vitest";
import { GoalElapsedTicker } from "../../src/core/extensions/builtin/goal/elapsed-ticker.ts";
import { MonitorAwareGoalContinuation } from "../../src/core/extensions/builtin/goal/monitor-continuation.ts";
import type { Goal } from "../../src/core/extensions/builtin/goal/types.ts";
import { GoalWaitTicker } from "../../src/core/extensions/builtin/goal/wait-ticker.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";

/** The runtime contract thrown by a retired extension context (agent-session). */
const STALE_CTX_MESSAGE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";

const fakeCtx = { isIdle: () => true, ui: { setStatus: () => {} } } as unknown as ExtensionContext;

function activeGoal(): Goal {
	return {
		id: "goal-1",
		threadId: "goal-1-thread",
		objective: "Keep moving",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
	};
}

describe("goal tickers vs retired extension contexts", () => {
	it("MonitorAwareGoalContinuation.dispose() stops the wait ticker interval", () => {
		vi.useFakeTimers();
		try {
			const ticker = new GoalWaitTicker({ render: () => {} });
			const pi = { events: { on: () => () => {} } } as unknown as ExtensionAPI;
			const monitor = new MonitorAwareGoalContinuation(
				pi,
				() => false,
				() => {},
				ticker,
			);
			ticker.sync(fakeCtx, { kind: "monitor", remainingMs: 60_000, totalMs: 60_000, channelCounts: {} });
			expect(ticker.running).toBe(true);

			monitor.dispose();

			expect(ticker.running).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("GoalWaitTicker retires itself when a tick hits a stale extension context", () => {
		vi.useFakeTimers();
		try {
			let renders = 0;
			const ticker = new GoalWaitTicker({
				render: () => {
					renders += 1;
					if (renders > 1) throw new Error(STALE_CTX_MESSAGE);
				},
			});
			ticker.sync(fakeCtx, { kind: "monitor", remainingMs: 60_000, totalMs: 60_000, channelCounts: {} });
			expect(ticker.running).toBe(true);

			// The session is replaced; the retained ctx goes stale and the next tick throws.
			expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();

			expect(ticker.running).toBe(false);
			// A dead ticker must not keep attempting renders on later ticks.
			const rendersAfterRetire = renders;
			vi.advanceTimersByTime(5_000);
			expect(renders).toBe(rendersAfterRetire);
		} finally {
			vi.useRealTimers();
		}
	});

	it("GoalElapsedTicker retires itself when a tick hits a stale extension context", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		try {
			let renders = 0;
			const ticker = new GoalElapsedTicker({
				render: () => {
					renders += 1;
					if (renders > 1) throw new Error(STALE_CTX_MESSAGE);
				},
			});
			ticker.sync(fakeCtx, activeGoal(), Date.now());
			expect(ticker.running).toBe(true);

			expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();

			expect(ticker.running).toBe(false);
			const rendersAfterRetire = renders;
			vi.advanceTimersByTime(5_000);
			expect(renders).toBe(rendersAfterRetire);
		} finally {
			vi.useRealTimers();
		}
	});
});
