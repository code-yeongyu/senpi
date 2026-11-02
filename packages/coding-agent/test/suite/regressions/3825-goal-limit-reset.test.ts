import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ProviderDiagnostic } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { providerRetryAt, providerRetryDelayMs } from "../../../src/core/extensions/builtin/goal/provider-retry.ts";
import { createGoal } from "../../../src/core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../../src/core/extensions/builtin/goal/store-ref.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	makeGoalContext,
	runGoalHandlers,
	waitForSentCount,
} from "../goal-monitor-test-harness.ts";

const NOW = Date.UTC(2026, 9, 20, 12);
const RESET = NOW + 2 * 60 * 60_000;

function failure(errorMessage: string, providerDiagnostic?: ProviderDiagnostic): AgentMessage {
	const message = cleanAssistantStop();
	if (message.role !== "assistant") throw new Error("Expected assistant fixture");
	return { ...message, stopReason: "error", errorMessage, ...(providerDiagnostic ? { providerDiagnostic } : {}) };
}

describe("goal recovery honors machine-readable usage-limit resets (#3825)", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await cleanupGoalMonitorTempDirs();
	});

	it.each(["quota", "rate_limit"] as const)("prefers a structured %s reset over text and retry hints", (category) => {
		const message = failure(`Usage limit until ${new Date(NOW + 60_000).toISOString()} (retry-after-ms: 120000)`, {
			category,
			evidence: "structured_code",
			resetsAt: RESET,
		});
		expect(providerRetryAt([message], NOW)).toBe(RESET);
	});

	it("reads the provider retry-after marker before an ISO instant", () => {
		const message = failure(
			`You've hit your session limit; ${new Date(NOW + 60_000).toISOString()} (retry-after-ms: 7200000)`,
		);
		expect(providerRetryAt([message], NOW)).toBe(RESET);
	});

	it.each([NOW - 1, Number.NaN, Number.POSITIVE_INFINITY])("ignores an invalid structured reset %s", (resetsAt) => {
		const message = failure(`blocked until ${new Date(RESET).toISOString()}`, {
			category: "quota",
			evidence: "structured_code",
			resetsAt,
		});
		expect(providerRetryAt([message], NOW)).toBe(RESET);
	});

	it("does not use an auth diagnostic as a usage reset", () => {
		const message = failure("Authentication failed", {
			category: "auth",
			evidence: "structured_code",
			resetsAt: RESET,
		});
		expect(providerRetryAt([message], NOW)).toBeUndefined();
	});

	it("keeps ordinary recovery backoff when no reset is known", () => {
		expect(providerRetryAt([failure("upstream unavailable")], NOW)).toBeUndefined();
		expect(providerRetryDelayMs(1, undefined, NOW)).toBe(0);
		expect(providerRetryDelayMs(2, undefined, NOW)).toBe(15_000);
	});

	it("sends no recovery before a two-hour reset and sends once at the reset margin", async () => {
		vi.useFakeTimers({ now: NOW });
		const harness = createGoalHarness();
		const ctx = await makeGoalContext([], "thread-3825-structured-reset");
		await runGoalHandlers(harness.handlers, "session_start", { type: "session_start", reason: "new" }, ctx);
		await createGoal(goalStoreRef(ctx.sessionManager, ctx.cwd), "Recover after the provider limit resets");
		await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(
			harness.handlers,
			"agent_end",
			{
				type: "agent_end",
				aborted: false,
				willRetry: false,
				messages: [
					failure("You've hit your session limit", {
						category: "quota",
						evidence: "structured_code",
						resetsAt: RESET,
					}),
				],
			},
			ctx,
		);
		await runGoalHandlers(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);
		expect(harness.sent).toHaveLength(0);
		expect(harness.events.emitted).toContainEqual({
			channel: "goal_continuation_timer_state",
			data: expect.objectContaining({ armed: true, kind: "providerRetry", dueAtMs: RESET + 1_000 }),
		});
		await vi.advanceTimersByTimeAsync(RESET - NOW);
		expect(harness.sent).toHaveLength(0);
		const delivered = waitForSentCount(harness, 1);
		await vi.advanceTimersByTimeAsync(1_000);
		await delivered;
		expect(harness.sent).toHaveLength(1);
	});
});
