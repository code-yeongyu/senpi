import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { computeSessionFailureReport, MIN_CACHEABLE_PROMPT_TOKENS } from "../../src/core/session-failure-report.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

const START = Date.parse("2026-09-27T00:00:00.000Z");

function assistantEntry(
	id: string,
	startedAt: number,
	durationMs: number,
	message: Partial<AssistantMessage> & Pick<AssistantMessage, "stopReason">,
): SessionEntry {
	const base = fauxAssistantMessage("reply", { stopReason: message.stopReason, timestamp: startedAt });
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date(startedAt + durationMs).toISOString(),
		message: { ...base, ...message, usage: { ...base.usage, ...message.usage } },
	};
}

function usage(input: number, cacheRead: number, cacheWrite = 0): AssistantMessage["usage"] {
	const base = fauxAssistantMessage("usage").usage;
	return { ...base, input, cacheRead, cacheWrite };
}

describe("computeSessionFailureReport", () => {
	it("counts failed requests, their time, and full cache misses right after a failure", () => {
		const report = computeSessionFailureReport([
			assistantEntry("a", START, 400, { stopReason: "stop", usage: usage(3_000, 0) }),
			assistantEntry("b", START + 1_000, 1_500, { stopReason: "error" }),
			assistantEntry("c", START + 3_000, 500, { stopReason: "aborted" }),
			assistantEntry("d", START + 4_000, 900, { stopReason: "stop", usage: usage(9_000, 0, 1_000) }),
			assistantEntry("e", START + 6_000, 700, { stopReason: "error" }),
			assistantEntry("f", START + 7_000, 800, { stopReason: "toolUse", usage: usage(100, 12_000) }),
		]);

		expect(report).toEqual({
			requests: 6,
			erroredRequests: 2,
			abortedRequests: 1,
			failureShare: 0.5,
			failedDurationMs: 2_700,
			postFailureRequests: 2,
			postFailureFullMissRequests: 1,
			postFailureFullMissInputTokens: 10_000,
		});
	});

	it("does not count a zero cache read on a prompt too small to cache", () => {
		const report = computeSessionFailureReport([
			assistantEntry("a", START, 10, { stopReason: "error" }),
			assistantEntry("b", START + 100, 10, {
				stopReason: "stop",
				usage: usage(MIN_CACHEABLE_PROMPT_TOKENS - 1, 0),
			}),
		]);

		expect(report.postFailureRequests).toBe(1);
		expect(report.postFailureFullMissRequests).toBe(0);
		expect(report.postFailureFullMissInputTokens).toBe(0);
	});

	it("does not attribute a later user turn to an earlier failure", () => {
		const nextDay = START + 86_400_000;
		const report = computeSessionFailureReport([
			assistantEntry("a", START, 50, { stopReason: "aborted" }),
			{
				type: "message",
				id: "u",
				parentId: null,
				timestamp: new Date(nextDay).toISOString(),
				message: { role: "user", content: "an unrelated question", timestamp: nextDay },
			},
			assistantEntry("b", nextDay + 1_000, 900, { stopReason: "stop", usage: usage(5_000, 0) }),
		]);

		expect(report).toMatchObject({ abortedRequests: 1, postFailureRequests: 0, postFailureFullMissInputTokens: 0 });
	});

	it("reports an empty session as zero failures", () => {
		expect(computeSessionFailureReport([])).toMatchObject({ requests: 0, failureShare: 0, failedDurationMs: 0 });
	});
});

describe("getSessionStats failure report", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("records the failed request that preceded a chain fallback", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: { enabled: true, baseDelayMs: 1, maxRetries: 0, fallbackChains: { "faux/faux-1": ["faux/faux-2"] } },
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("fallback answer"),
		]);

		await harness.session.prompt("fails over once");

		expect(harness.session.getSessionStats().failures).toMatchObject({
			requests: 2,
			erroredRequests: 1,
			abortedRequests: 0,
			failureShare: 0.5,
			postFailureRequests: 1,
		});
	});
});
