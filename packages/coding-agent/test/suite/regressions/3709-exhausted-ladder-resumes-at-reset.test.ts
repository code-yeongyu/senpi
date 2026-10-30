import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import goalExtension from "../../../src/core/extensions/builtin/goal/index.ts";
import { createHarness, type Harness } from "../harness.ts";

// senpi#3709: once every rung of the fallback ladder failed, nothing was scheduled, so a goal
// session sat idle until new input even when the limit errors named when they reset.

const NOW = Date.UTC(2026, 9, 19, 7, 50, 0);
const HOUR = 60 * 60_000;
const SOONEST_RESET = NOW + 5 * HOUR;

function failure(errorMessage: string): FauxResponseStep {
	return fauxAssistantMessage("", { stopReason: "error", errorMessage });
}

async function goalOnLadder(rungFailures: readonly FauxResponseStep[]): Promise<Harness> {
	const harness = await createHarness({
		models: [{ id: "faux-1" }, { id: "faux-2" }, { id: "faux-3" }],
		extensionFactories: [goalExtension],
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
	harness.setResponses([
		fauxAssistantMessage([fauxToolCall("create_goal", { objective: "Keep going" })], { stopReason: "toolUse" }),
		...rungFailures,
		fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	return harness;
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
		vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true });
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

		await advanceTo(SOONEST_RESET + 2_000);
		await vi.waitFor(() => expect(harness.getPendingResponseCount()).toBe(0), { timeout: 5_000 });
		expect(runsAfterExhaustion(harness)).toBe(1);

		await advanceTo(NOW + 80 * HOUR);
		expect(runsAfterExhaustion(harness)).toBe(1);
	}, 30_000);

	it("schedules no resume when no rung named a reset time", async () => {
		vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true });
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
});
