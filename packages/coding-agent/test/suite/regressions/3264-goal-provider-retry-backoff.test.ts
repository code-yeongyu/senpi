import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionToolContext } from "../../../src/core/extensions/types.ts";
import {
	cleanAssistantStop,
	cleanupGoalMonitorTempDirs,
	createGoalHarness,
	makeGoalContext,
	runGoalHandlers,
	waitForSentCount,
} from "../goal-monitor-test-harness.ts";

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

function providerFailure(errorMessage: string, text?: string) {
	const base = cleanAssistantStop();
	const content =
		text === undefined || base.role !== "assistant" ? {} : { content: [{ type: "text" as const, text }] };
	return {
		type: "agent_end" as const,
		aborted: false,
		willRetry: false,
		messages: [{ ...base, ...content, stopReason: "error" as const, errorMessage }],
	};
}

async function goalSession(thread: string) {
	const harness = createGoalHarness();
	const ctx = await makeGoalContext([], thread);
	await harness.tools
		.get("create_goal")
		?.execute("create", { objective: "Keep going" }, undefined, undefined, ctx as ExtensionToolContext);
	const failTurn = async (errorMessage: string, text?: string) => {
		await runGoalHandlers(harness.handlers, "agent_start", { type: "agent_start" }, ctx);
		await runGoalHandlers(harness.handlers, "agent_end", providerFailure(errorMessage, text), ctx);
		await runGoalHandlers(harness.handlers, "agent_settled", { type: "agent_settled" }, ctx);
	};
	return { harness, ...harness, ctx, failTurn };
}

function armedTimers(emitted: readonly { channel: string; data: unknown }[]) {
	return emitted
		.filter((event) => event.channel === "goal_continuation_timer_state")
		.map((event) => event.data as { armed: boolean; kind: string; dueAtMs?: number })
		.filter((data) => data.armed);
}

describe("goal continuation backs off while the provider is down (senpi#3264)", () => {
	afterEach(async () => {
		vi.useRealTimers();
		await cleanupGoalMonitorTempDirs();
	});

	it("retries the first failure at once, then waits instead of bursting", async () => {
		vi.useFakeTimers({ now: NOW });
		const { harness, sent, events, failTurn } = await goalSession("thread-3264-backoff");

		await failTurn("server_error: upstream unavailable");
		expect(sent).toHaveLength(1);

		await failTurn("server_error: upstream unavailable");
		expect(sent).toHaveLength(1);
		expect(armedTimers(events.emitted).at(-1)).toMatchObject({ kind: "providerRetry", dueAtMs: NOW + 15_000 });

		await vi.advanceTimersByTimeAsync(15_000);
		await waitForSentCount(harness, 2, { timeoutMs: 5_000 });
		expect(sent).toHaveLength(2);
	});

	it("doubles the wait for each further failure instead of bursting", async () => {
		vi.useFakeTimers({ now: NOW });
		const { sent, events, failTurn } = await goalSession("thread-3264-no-burst");

		for (let attempt = 0; attempt < 4; attempt++) await failTurn("server_error: upstream unavailable");

		expect(sent).toHaveLength(1);
		expect(armedTimers(events.emitted).map((timer) => (timer.dueAtMs ?? 0) - NOW)).toEqual([15_000, 30_000, 60_000]);
	});

	it("wakes when the pool says an account frees up", async () => {
		vi.useFakeTimers({ now: NOW });
		const { harness, sent, events, failTurn } = await goalSession("thread-3264-wake");
		const freesAt = NOW + 15 * 60_000;

		await failTurn(`All Anthropic Subscription accounts are blocked until ${new Date(freesAt).toISOString()}.`);

		expect(sent).toHaveLength(0);
		expect(armedTimers(events.emitted).at(-1)).toMatchObject({ kind: "providerRetry", dueAtMs: freesAt + 1_000 });
		await vi.advanceTimersByTimeAsync(15 * 60_000 + 1_000);
		await waitForSentCount(harness, 1, { timeoutMs: 5_000 });
		expect(sent).toHaveLength(1);
	});

	it("starts over at an immediate retry after the user steps in", async () => {
		vi.useFakeTimers({ now: NOW });
		const { harness, sent, events, handlers, ctx, failTurn } = await goalSession("thread-3264-user-reset");
		for (let attempt = 0; attempt < 3; attempt++) await failTurn("server_error: upstream unavailable");
		const armedBefore = armedTimers(events.emitted).length;

		await runGoalHandlers(
			handlers,
			"input",
			{ type: "input", inputId: "retry", text: "try again", source: "interactive" },
			ctx,
		);
		await runGoalHandlers(
			handlers,
			"input_disposition",
			{ type: "input_disposition", inputId: "retry", disposition: "started" },
			ctx,
		);
		const sentBefore = sent.length;
		await failTurn("server_error: upstream unavailable");

		await waitForSentCount(harness, sentBefore + 1, { timeoutMs: 5_000 });
		expect(armedTimers(events.emitted)).toHaveLength(armedBefore);
	});

	it("ignores timestamps in the assistant's own text when no error names one", async () => {
		vi.useFakeTimers({ now: NOW });
		const { harness, sent, failTurn } = await goalSession("thread-3264-text-timestamp");
		await failTurn("server_error: upstream unavailable");
		expect(sent).toHaveLength(1);
		const deadline = new Date(NOW + 5 * 60 * 60_000).toISOString();

		await failTurn("server_error: upstream unavailable", `Deadline noted: ${deadline}`);
		await vi.advanceTimersByTimeAsync(15_000);

		await waitForSentCount(harness, 2, { timeoutMs: 5_000 });
		expect(sent).toHaveLength(2);
	});
});
