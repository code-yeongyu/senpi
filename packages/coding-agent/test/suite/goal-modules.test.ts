import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { parseGoalCommand } from "../../src/core/extensions/builtin/goal/command.ts";
import {
	shouldQueueGoalContinuationAfterAgentEnd,
	shouldQueueGoalContinuationWhenIdle,
} from "../../src/core/extensions/builtin/goal/continuation.ts";
import {
	formatGoalElapsedSeconds,
	formatGoalForTool,
	formatTokensCompact,
	goalToolResponse,
} from "../../src/core/extensions/builtin/goal/format.ts";
import { buildContinuationPrompt } from "../../src/core/extensions/builtin/goal/prompt.ts";
import type { Goal } from "../../src/core/extensions/builtin/goal/types.ts";
import { goalStatusText, STATUS_KEY, updateGoalUi } from "../../src/core/extensions/builtin/goal/ui.ts";

function makeGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		id: "goal-1",
		threadId: "thread-1",
		objective: "Ship the feature",
		status: "active",
		tokensUsed: 0,
		timeUsedSeconds: 0,
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function assistantMessageWithStopReason(stopReason: "aborted" | "error" | "stop" | "toolUse"): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		errorMessage:
			stopReason === "aborted"
				? "Operation aborted"
				: stopReason === "error"
					? "429 usage limit reached"
					: undefined,
		timestamp: Date.now(),
	};
}

function abortedToolResultMessage(): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "wait",
		content: [{ type: "text", text: "Operation aborted" }],
		isError: true,
		timestamp: Date.now(),
	};
}

describe("goal command parsing", () => {
	it("maps bare input, keywords, and objectives", () => {
		expect(parseGoalCommand("")).toEqual({ kind: "show" });
		expect(parseGoalCommand("  ")).toEqual({ kind: "show" });
		expect(parseGoalCommand("pause")).toEqual({ kind: "setStatus", status: "paused" });
		expect(parseGoalCommand("RESUME")).toEqual({ kind: "setStatus", status: "active" });
		expect(parseGoalCommand("clear")).toEqual({ kind: "clear" });
		expect(parseGoalCommand("Ship it")).toEqual({ kind: "setObjective", objective: "Ship it" });
	});
});

describe("goal continuation gating", () => {
	it("queues only for active idle goals with no pending messages", () => {
		const active = makeGoal({ status: "active" });
		expect(shouldQueueGoalContinuationWhenIdle(active, true, false)).toBe(true);
		expect(shouldQueueGoalContinuationWhenIdle(active, false, false)).toBe(false);
		expect(shouldQueueGoalContinuationWhenIdle(active, true, true)).toBe(false);
		expect(shouldQueueGoalContinuationWhenIdle(makeGoal({ status: "paused" }), true, false)).toBe(false);
		expect(shouldQueueGoalContinuationWhenIdle(null, true, false)).toBe(false);
	});

	it("queues after agent end for active goals with no pending messages", () => {
		const cleanMessages = [assistantMessageWithStopReason("stop")];
		expect(shouldQueueGoalContinuationAfterAgentEnd(makeGoal({ status: "active" }), false, cleanMessages)).toBe(true);
		expect(shouldQueueGoalContinuationAfterAgentEnd(makeGoal({ status: "active" }), true, cleanMessages)).toBe(false);
		expect(shouldQueueGoalContinuationAfterAgentEnd(makeGoal({ status: "complete" }), false, cleanMessages)).toBe(
			false,
		);
		expect(shouldQueueGoalContinuationAfterAgentEnd(makeGoal({ status: "active" }), false, [])).toBe(false);
		expect(
			shouldQueueGoalContinuationAfterAgentEnd(makeGoal({ status: "active" }), false, [
				assistantMessageWithStopReason("aborted"),
			]),
		).toBe(false);
		expect(
			shouldQueueGoalContinuationAfterAgentEnd(makeGoal({ status: "active" }), false, [
				assistantMessageWithStopReason("error"),
			]),
		).toBe(false);
		expect(
			shouldQueueGoalContinuationAfterAgentEnd(makeGoal({ status: "active" }), false, [
				assistantMessageWithStopReason("toolUse"),
				abortedToolResultMessage(),
			]),
		).toBe(false);
	});
});

describe("goal formatting (budget-free)", () => {
	it("formats elapsed seconds and compact tokens", () => {
		expect(formatGoalElapsedSeconds(45)).toBe("45s");
		expect(formatGoalElapsedSeconds(90)).toBe("1m");
		expect(formatGoalElapsedSeconds(3_600)).toBe("1h");
		expect(formatTokensCompact(999)).toBe("999");
		expect(formatTokensCompact(1_500)).toBe("1.5K");
		expect(formatTokensCompact(2_000_000)).toBe("2M");
	});

	it("renders the tool view without any budget fields", () => {
		const text = formatGoalForTool(makeGoal({ tokensUsed: 1_200, timeUsedSeconds: 65 }));
		expect(text).toContain("Objective: Ship the feature");
		expect(text).toContain("Status: active");
		expect(text).toContain("Time used: 1m");
		expect(text).toContain("Tokens used: 1.2K");
		expect(text.toLowerCase()).not.toContain("budget");
		expect(text.toLowerCase()).not.toContain("remaining");
	});

	it("produces a snapshot response with no budget keys", () => {
		const response = goalToolResponse(makeGoal({ tokensUsed: 10 }));
		expect(response.goal).toMatchObject({ threadId: "thread-1", objective: "Ship the feature", tokensUsed: 10 });
		expect(JSON.stringify(response)).not.toContain("Budget");
		expect(JSON.stringify(response)).not.toContain("remaining");
		expect(goalToolResponse(null).goal).toBeNull();
	});
});

describe("goal continuation prompt (budget-free)", () => {
	it("embeds the objective and usage, never budget language", () => {
		const prompt = buildContinuationPrompt(
			makeGoal({ objective: "Fix <bug> & ship", tokensUsed: 5, timeUsedSeconds: 12 }),
		);
		expect(prompt).toContain("<untrusted_objective>");
		expect(prompt).toContain("Fix &lt;bug&gt; &amp; ship");
		expect(prompt).toContain("Usage so far:");
		expect(prompt).toContain("Time spent pursuing goal: 12 seconds");
		expect(prompt).toContain("Tokens used: 5");
		expect(prompt.toLowerCase()).not.toContain("token budget");
		expect(prompt.toLowerCase()).not.toContain("tokens remaining");
		expect(prompt.toLowerCase()).not.toContain("budget_limited");
	});
});

describe("goal status UI", () => {
	it("derives status text for each state", () => {
		expect(goalStatusText(makeGoal({ status: "active", timeUsedSeconds: 0 }))).toBe("Pursuing goal");
		expect(goalStatusText(makeGoal({ status: "active", timeUsedSeconds: 65 }))).toBe("Pursuing goal (1m)");
		expect(goalStatusText(makeGoal({ status: "paused" }))).toBe("Goal paused (/goal resume)");
		expect(goalStatusText(makeGoal({ status: "complete" }))).toBe("Goal achieved");
	});

	it("sets and clears the status segment, respecting hasUI", () => {
		const calls: Array<{ key: string; text: string | undefined }> = [];
		const ctx = {
			hasUI: true,
			ui: { setStatus: (key: string, text: string | undefined) => calls.push({ key, text }) },
		} as unknown as Parameters<typeof updateGoalUi>[0];

		updateGoalUi(ctx, makeGoal({ status: "active" }));
		updateGoalUi(ctx, null);
		expect(calls).toEqual([
			{ key: STATUS_KEY, text: "Pursuing goal" },
			{ key: STATUS_KEY, text: undefined },
		]);

		const noUiCalls: unknown[] = [];
		const noUiCtx = {
			hasUI: false,
			ui: { setStatus: () => noUiCalls.push(1) },
		} as unknown as Parameters<typeof updateGoalUi>[0];
		updateGoalUi(noUiCtx, makeGoal());
		expect(noUiCalls).toHaveLength(0);
	});
});
