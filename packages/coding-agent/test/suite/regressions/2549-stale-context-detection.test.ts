import { describe, expect, it, vi } from "vitest";
import { GoalElapsedTicker } from "../../../src/core/extensions/builtin/goal/elapsed-ticker.ts";
import { isStaleExtensionContextError } from "../../../src/core/extensions/builtin/goal/stale-context.ts";
import type { Goal } from "../../../src/core/extensions/builtin/goal/types.ts";
import { GoalWaitTicker } from "../../../src/core/extensions/builtin/goal/wait-ticker.ts";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import { createHarness } from "../harness.ts";

/**
 * #2549: long-lived tickers retire on the error a retired extension context throws.
 * A reload and a session replacement retire the context with different messages, so
 * the detection is checked against the errors the real runtime throws, not a literal.
 */

function errorFrom(read: () => unknown): unknown {
	try {
		read();
	} catch (error) {
		return error;
	}
	throw new Error("expected the retired context to throw");
}

async function captureRetiredContextError(retire: "reload" | "dispose"): Promise<unknown> {
	let captured: ExtensionContext | undefined;
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("before_provider_request", (event, ctx) => {
					captured ??= ctx;
					return event.payload;
				});
			},
		],
	});
	try {
		const onPayload = harness.agent.onPayload;
		if (!onPayload) throw new Error("Expected the agent provider payload hook");
		await onPayload({ phase: "capture" }, harness.getModel());
		const context = captured;
		if (!context) throw new Error("Expected an extension context from the provider request");
		expect(() => context.ui).not.toThrow();

		if (retire === "reload") await harness.session.reload();
		else harness.session.dispose();

		return errorFrom(() => context.ui);
	} finally {
		harness.cleanup();
	}
}

function activeGoal(): Goal {
	return {
		id: "goal-2549",
		threadId: "goal-2549-thread",
		objective: "Keep moving",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 0,
		updatedAt: 0,
	};
}

describe("#2549 retired extension context detection", () => {
	it.each(["reload", "dispose"] as const)("recognizes the error a context retired by %s throws", async (retire) => {
		const error = await captureRetiredContextError(retire);

		expect(isStaleExtensionContextError(error)).toBe(true);
	});

	it("does not treat an unrelated failure as a retired context", () => {
		expect(isStaleExtensionContextError(new Error("disk exploded"))).toBe(false);
		expect(isStaleExtensionContextError("stale extension generation after reload")).toBe(false);
	});

	it("retires the goal elapsed ticker when a reload retires its context", async () => {
		const reloadError = await captureRetiredContextError("reload");
		vi.useFakeTimers();
		vi.setSystemTime(0);
		try {
			let renders = 0;
			const ticker = new GoalElapsedTicker({
				render: () => {
					renders += 1;
					if (renders > 1) throw reloadError;
				},
			});
			ticker.sync({ ui: { setStatus: () => {} } } as unknown as ExtensionContext, activeGoal(), Date.now());

			expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
			expect(ticker.running).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not arm the goal elapsed ticker for a sync whose first render is stale, and re-arms on a live sync", async () => {
		const reloadError = await captureRetiredContextError("reload");
		vi.useFakeTimers();
		vi.setSystemTime(0);
		try {
			let stale = true;
			const ticker = new GoalElapsedTicker({
				render: () => {
					if (stale) throw reloadError;
				},
			});
			const ctx = { ui: { setStatus: () => {} } } as unknown as ExtensionContext;

			expect(() => ticker.sync(ctx, activeGoal(), Date.now())).not.toThrow();
			expect(ticker.running).toBe(false);

			stale = false;
			ticker.sync(ctx, activeGoal(), Date.now());
			expect(ticker.running).toBe(true);
			ticker.stop();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not arm the goal wait ticker for a sync whose first render is stale, and re-arms on a live sync", async () => {
		const reloadError = await captureRetiredContextError("reload");
		vi.useFakeTimers();
		try {
			const ticker = new GoalWaitTicker({ render: () => {} });
			const wait = { kind: "monitor", remainingMs: 60_000, totalMs: 60_000, channelCounts: {} } as const;
			const retired = {
				isIdle: () => {
					throw reloadError;
				},
			} as unknown as ExtensionContext;

			expect(() => ticker.sync(retired, wait)).not.toThrow();
			expect(ticker.running).toBe(false);

			ticker.sync({ isIdle: () => true } as unknown as ExtensionContext, wait);
			expect(ticker.running).toBe(true);
			ticker.stop();
		} finally {
			vi.useRealTimers();
		}
	});
});
