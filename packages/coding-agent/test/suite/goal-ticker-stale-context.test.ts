import { describe, expect, it, vi } from "vitest";
import { GoalElapsedTicker } from "../../src/core/extensions/builtin/goal/elapsed-ticker.ts";
import { MonitorAwareGoalContinuation } from "../../src/core/extensions/builtin/goal/monitor-continuation.ts";
import type { Goal } from "../../src/core/extensions/builtin/goal/types.ts";
import { GoalWaitTicker } from "../../src/core/extensions/builtin/goal/wait-ticker.ts";
import { WAKE_SOURCE_STATE_EVENT } from "../../src/core/extensions/builtin/monitor-state-event.ts";
import type { ExtensionAPI, ExtensionContext } from "../../src/core/extensions/types.ts";

/** The runtime contract thrown by a retired extension context (agent-session). */
const STALE_CTX_MESSAGE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().";

const fakeCtx = { isIdle: () => true, ui: { setStatus: () => {} } } as unknown as ExtensionContext;

/**
 * A ctx retired by session replacement: every runner-guarded member rethrows the
 * stale contract error, exactly as the real `assertActive()` getters do. `hasUI`
 * is a getter (not a method) because that is the accessor shape that crashed in
 * production from the goal continuation timer callback.
 */
function retiredCtx(onNotify: () => void, options: { readonly staleFrom?: number } = {}): ExtensionContext {
	const stale = () => {
		throw new Error(STALE_CTX_MESSAGE);
	};
	// `staleFrom` lets a ctx stay live long enough to arm the timer and go stale
	// only once the callback runs — the real session-replacement ordering.
	let hasUIReads = 0;
	return {
		get hasUI(): boolean {
			hasUIReads += 1;
			if (hasUIReads <= (options.staleFrom ?? 0)) return true;
			return stale();
		},
		get ui(): unknown {
			return {
				notify: () => {
					onNotify();
				},
				setStatus: () => {},
			};
		},
		isIdle: () => {
			if (hasUIReads < (options.staleFrom ?? 0)) return true;
			return stale();
		},
		hasPendingMessages: stale,
		getPromptCacheSafeWaitSeconds: () => undefined,
		getPromptCacheGoalBackstopMaxSeconds: () => 3570,
	} as unknown as ExtensionContext;
}

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

	// Regression: the armed continuation timer fires from a bare setTimeout, so a
	// stale-ctx throw inside the callback (including inside its own catch handler,
	// which read `this.#ctx?.hasUI` — optional chaining guards undefined, never a
	// retired object) escaped as an uncaughtException and killed the session.
	it.each([
		// Stale before the timer is even armed: `#armTimer` reads `ctx?.hasUI`
		// synchronously, so the throw escapes into whichever event handler re-armed it.
		{ label: "while arming the timer", staleFrom: 0 },
		// Stale only once the callback runs: the reported production crash, where the
		// throw escapes a bare setTimeout as an uncaughtException.
		{ label: "when the armed timer fires", staleFrom: 1 },
	])("MonitorAwareGoalContinuation contains a stale ctx $label", async ({ staleFrom }) => {
		vi.useFakeTimers();
		// The crash escaped a bare setTimeout, so it surfaces as an unhandled
		// rejection rather than a thrown assertion. Capture it explicitly.
		const escaped: unknown[] = [];
		const onUnhandled = (reason: unknown): void => {
			escaped.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			let notifies = 0;
			const ctx = retiredCtx(
				() => {
					notifies += 1;
				},
				{ staleFrom },
			);
			const listeners = new Map<string, Array<(data: unknown) => void>>();
			const pi = {
				events: {
					on: (channel: string, handler: (data: unknown) => void) => {
						const handlers = listeners.get(channel) ?? [];
						handlers.push(handler);
						listeners.set(channel, handlers);
						return () => {};
					},
					emit: () => {},
				},
			} as unknown as ExtensionAPI;
			const monitor = new MonitorAwareGoalContinuation(pi);

			// A live wake source keeps the monitor backstop armable.
			for (const handler of listeners.get(WAKE_SOURCE_STATE_EVENT) ?? []) {
				handler({ source: "terminal-monitors", activeCount: 1 });
			}
			monitor.start(ctx);
			monitor.rearmMonitorBackstop(activeGoal());

			// The session was replaced without dispose(), so the retained ctx is stale
			// when the backstop finally fires. Nothing may escape the timer callback.
			expect(() => vi.advanceTimersByTime(3_600_000)).not.toThrow();
			await vi.runAllTimersAsync();
			// Let any rejection the callback failed to contain reach the process handler.
			vi.useRealTimers();
			await new Promise((resolve) => setImmediate(resolve));

			expect(escaped).toEqual([]);
			// A dead ctx cannot show UI, so no notify may be attempted against it.
			expect(notifies).toBe(0);
		} finally {
			process.off("unhandledRejection", onUnhandled);
			vi.useRealTimers();
		}
	});

	// The stale-ctx containment above must not become a blanket catch: a LIVE ctx
	// still has to surface a genuine delivery failure to the user.
	it("MonitorAwareGoalContinuation still reports a delivery failure on a live ctx", async () => {
		vi.useFakeTimers();
		try {
			const notices: string[] = [];
			const ctx = {
				hasUI: true,
				ui: {
					notify: (message: string) => notices.push(message),
					setStatus: () => {},
				},
				// A live ctx that fails for an unrelated reason must not be silenced.
				isIdle: () => {
					throw new Error("disk exploded");
				},
				hasPendingMessages: () => false,
				getPromptCacheSafeWaitSeconds: () => undefined,
				getPromptCacheGoalBackstopMaxSeconds: () => 3570,
			} as unknown as ExtensionContext;
			const listeners = new Map<string, Array<(data: unknown) => void>>();
			const pi = {
				events: {
					on: (channel: string, handler: (data: unknown) => void) => {
						const handlers = listeners.get(channel) ?? [];
						handlers.push(handler);
						listeners.set(channel, handlers);
						return () => {};
					},
					emit: () => {},
				},
			} as unknown as ExtensionAPI;
			const monitor = new MonitorAwareGoalContinuation(pi);
			for (const handler of listeners.get(WAKE_SOURCE_STATE_EVENT) ?? []) {
				handler({ source: "terminal-monitors", activeCount: 1 });
			}
			monitor.start(ctx);
			monitor.rearmMonitorBackstop(activeGoal());

			vi.advanceTimersByTime(3_600_000);
			await vi.runAllTimersAsync();

			expect(notices).toEqual(["Goal continuation delivery failed: disk exploded"]);
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
