import { clearTimeout as clearRealTimeout, setTimeout as setRealTimeout } from "node:timers";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import type { AgentSettledEvent } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#3709: once every rung of the fallback ladder failed, nothing was scheduled, so a goal
// session sat idle until new input even when the limit errors named when they reset.

const NOW = Date.UTC(2026, 9, 19, 7, 50, 0);
const HOUR = 60 * 60_000;
const SOONEST_RESET = NOW + 5 * HOUR;

function failure(errorMessage: string): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage });
}

async function goalOnLadder(
	rungFailures: readonly FauxResponseStep[],
	onSettled?: (event: AgentSettledEvent) => void,
): Promise<Harness> {
	const harness = await createHarness({
		models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }],
		extensionFactories: [
			goalExtension,
			(pi) => {
				pi.on("agent_settled", (event) => onSettled?.(event));
			},
		],
		fallbackNow: () => Date.now(),
		fallbackWallNow: () => Date.now(),
		settings: {
			retry: {
				enabled: true,
				maxRetries: 0,
				baseDelayMs: 1,
				fallbackChains: { "faux/faux-1": ["faux/faux-2", "faux/faux-3"] },
			},
		},
	});
	// Drive only the core's announced retry waits; goal waits remain under each test's clock.
	harness.session.subscribe((event) => {
		if (event.type === "auto_retry_start") {
			queueMicrotask(() => void vi.advanceTimersByTimeAsync(event.delayMs));
		}
	});
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("create_goal", { objective: "Keep going" })], { stopReason: "toolUse" }),
		...rungFailures,
		fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	return harness;
}

function waitForSettles(harness: Harness, count: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const timeout = setRealTimeout(() => {
			unsubscribe();
			reject(new Error(`Expected ${count} settled runs`));
		}, 5_000);
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type !== "agent_settled" || harness.eventsOfType("agent_settled").length < count) return;
			clearRealTimeout(timeout);
			unsubscribe();
			resolve();
		});
	});
}

function runsAfterExhaustion(harness: Harness): number {
	const exhaustedAt = harness.events.findIndex((event) => event.type === "retry_fallback_exhausted");
	expect(exhaustedAt).toBeGreaterThanOrEqual(0);
	return harness.events.slice(exhaustedAt).filter((event) => event.type === "agent_start").length;
}

async function advanceTo(at: number): Promise<void> {
	await vi.advanceTimersByTimeAsync(at - Date.now());
}

describe("an exhausted fallback ladder resumes the goal at the soonest known reset (senpi#3709)", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
		vi.useRealTimers();
	});

	it("schedules exactly one resume at the soonest reset the rungs named, with no turn before it", async () => {
		vi.useFakeTimers({ now: NOW });
		const harness = await goalOnLadder([
			failure("429 You've hit your session limit for this model, resets in 5 hours"),
			failure("HTTP 429: rate_limit_exceeded"),
			failure("429 You've hit your weekly limit for this model, resets in 3 days"),
		]);
		harnesses.push(harness);

		await harness.session.prompt("start");
		expect(harness.eventsOfType("retry_fallback_exhausted")).toHaveLength(1);
		expect(runsAfterExhaustion(harness)).toBe(0);

		await advanceTo(SOONEST_RESET - 1);
		expect(runsAfterExhaustion(harness)).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(2);

		const resumed = waitForSettles(harness, 2);
		await advanceTo(SOONEST_RESET + 2_000);
		await resumed;
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(runsAfterExhaustion(harness)).toBe(1);

		await advanceTo(NOW + 80 * HOUR);
		expect(runsAfterExhaustion(harness)).toBe(1);
	}, 30_000);

	it("schedules no resume when no rung named a reset time", async () => {
		vi.useFakeTimers({ now: NOW });
		const harness = await goalOnLadder([
			failure("429 You've hit your session limit for this model"),
			failure("HTTP 429: rate_limit_exceeded"),
			failure("429 You've hit your weekly limit for this model"),
		]);
		harnesses.push(harness);

		await harness.session.prompt("start");
		expect(harness.eventsOfType("retry_fallback_exhausted")).toHaveLength(1);

		await advanceTo(NOW + 80 * HOUR);
		expect(runsAfterExhaustion(harness)).toBe(0);
		expect(harness.getPendingResponseCount()).toBe(2);
	}, 30_000);

	it.each([
		"HTTP 503: upstream unavailable",
		"network error: connection reset",
		"Error: provider rejected the request permanently",
	])(
		"keeps immediate recovery and subsequent backoff after an outage ladder: %s",
		async (error) => {
			vi.useFakeTimers({ now: NOW });
			const harness = await goalOnLadder([
				failure(error),
				failure(error),
				failure("HTTP 503: upstream unavailable"),
				failure("HTTP 503: upstream unavailable"),
			]);
			harnesses.push(harness);
			const backedOff = waitForSettles(harness, 2);
			void backedOff.catch(() => {});

			await harness.session.prompt("start");
			// The first outage recovery must be admitted immediately, not parked without a reset.
			expect(runsAfterExhaustion(harness)).toBe(1);
			await backedOff;
			expect(harness.getPendingResponseCount()).toBe(2);
			await advanceTo(NOW + 14_999);
			expect(runsAfterExhaustion(harness)).toBe(1);

			const recovered = waitForSettles(harness, 3);
			await advanceTo(NOW + 15_000);
			await recovered;
			expect(runsAfterExhaustion(harness)).toBe(2);
			expect(harness.getPendingResponseCount()).toBe(0);
		},
	);

	it("resumes after one second when every collected reset passed before settlement", async () => {
		vi.useFakeTimers({ now: NOW });
		const settled: AgentSettledEvent[] = [];
		const harness = await goalOnLadder(
			[
				failure("429 You've hit your session limit for this model, resets in 1 second"),
				failure("HTTP 429: rate_limit_exceeded"),
				() => {
					vi.setSystemTime(NOW + 2_000);
					return failure("HTTP 429: rate_limit_exceeded");
				},
			],
			(event) => {
				settled.push(event);
			},
		);
		harnesses.push(harness);

		await harness.session.prompt("start");
		expect(runsAfterExhaustion(harness)).toBe(0);
		expect(settled.at(-1)?.fallbackExhausted).toEqual({ resumeAt: NOW + 1_000 });
		await advanceTo(NOW + 2_999);
		expect(runsAfterExhaustion(harness)).toBe(0);
		const resumed = waitForSettles(harness, 2);
		await advanceTo(NOW + 3_000);
		await resumed;
		expect(runsAfterExhaustion(harness)).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
