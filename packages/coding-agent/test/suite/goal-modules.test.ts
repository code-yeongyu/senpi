import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { parseGoalCommand } from "../../src/core/extensions/builtin/goal/command.ts";
import {
	evaluateGoalContinuation,
	type GoalContinuationInput,
	shouldQueueGoalContinuationAfterAgentEnd,
	shouldQueueGoalContinuationWhenIdle,
} from "../../src/core/extensions/builtin/goal/continuation.ts";
import {
	formatGoalElapsedSeconds,
	formatGoalForTool,
	formatTokensCompact,
	goalToolResponse,
} from "../../src/core/extensions/builtin/goal/format.ts";
import {
	buildContinuationPrompt,
	buildGoalStallNotice,
	buildMonitorStallNotice,
	buildTruncationRecoveryPrompt,
} from "../../src/core/extensions/builtin/goal/prompt.ts";
import type { Goal } from "../../src/core/extensions/builtin/goal/types.ts";
import {
	goalStatusText,
	STATUS_KEY,
	truncateGoalObjective,
	updateGoalUi,
} from "../../src/core/extensions/builtin/goal/ui.ts";

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
		expect(
			shouldQueueGoalContinuationWhenIdle(
				makeGoal({ status: "blocked", blockedReason: "Waiting", blockedAt: 1 }),
				true,
				false,
			),
		).toBe(false);
		expect(shouldQueueGoalContinuationWhenIdle(null, true, false)).toBe(false);
	});

	it("queues after agent end for active goals with no pending messages", () => {
		const cleanMessages = [assistantMessageWithStopReason("stop")];
		expect(shouldQueueGoalContinuationAfterAgentEnd(makeGoal({ status: "active" }), false, cleanMessages)).toBe(true);
		expect(shouldQueueGoalContinuationAfterAgentEnd(makeGoal({ status: "active" }), true, cleanMessages)).toBe(false);
		expect(shouldQueueGoalContinuationAfterAgentEnd(makeGoal({ status: "complete" }), false, cleanMessages)).toBe(
			false,
		);
		expect(
			shouldQueueGoalContinuationAfterAgentEnd(
				makeGoal({ status: "blocked", blockedReason: "Waiting", blockedAt: 1 }),
				false,
				cleanMessages,
			),
		).toBe(false);
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

	it("applies the persisted cap on every continuation path", () => {
		const input = {
			goal: makeGoal({ consecutiveContinuations: 8 }),
			isIdle: true,
			hasPendingMessages: false,
			lastStopReason: "stop",
			consecutiveContinuations: 8,
			lastContinuationSignature: undefined,
			currentSignature: undefined,
			consecutiveLengthRecoveries: 0,
			recentNormalizedOutputHashes: [],
			toollessContinuationStreak: 0,
			continuationPending: false,
		} satisfies Omit<GoalContinuationInput, "path">;

		expect(evaluateGoalContinuation({ ...input, path: "immediate" })).toEqual({ kind: "deny", reason: "cap" });
		expect(evaluateGoalContinuation({ ...input, path: "sessionStart" })).toEqual({ kind: "deny", reason: "cap" });
		expect(evaluateGoalContinuation({ ...input, path: "monitorDelayed" })).toEqual({
			kind: "deny",
			reason: "cap",
		});
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

	it("carries a decisive completion audit that must flip to update_goal complete", () => {
		const prompt = buildContinuationPrompt(makeGoal());
		expect(prompt).toMatch(/completion audit/i);
		expect(prompt).toMatch(/call update_goal with status "complete" in this same turn/i);
		expect(prompt).toMatch(/leaving the goal active/i);
		expect(prompt).toMatch(/todo task/i);
		expect(prompt).toMatch(/completed or dropped/i);
	});

	it("carries a conservative blocked audit gated on a recurring, unmistakable impasse", () => {
		const prompt = buildContinuationPrompt(makeGoal());
		expect(prompt).toMatch(/blocked audit/i);
		expect(prompt).toMatch(/unmistakably clear/i);
		expect(prompt).toMatch(/three consecutive goal turns/i);
		expect(prompt).toMatch(/hard, slow, uncertain/i);
		expect(prompt).toMatch(/user input or an external-state change/i);
	});

	it("treats waiting on a live resumption channel as a legal turn ending, never as blocked", () => {
		const prompt = buildContinuationPrompt(makeGoal());
		expect(prompt).toMatch(/live resumption channel/i);
		expect(prompt).toMatch(/wait.*not an impasse|never grounds a blocked/i);
	});

	it("gates the blocked audit on having no live resumption channel", () => {
		const prompt = buildContinuationPrompt(makeGoal());
		expect(prompt).toMatch(/no active monitor/i);
		expect(prompt).toMatch(/end the turn and let it wake/i);
	});

	it("forbids ending a goal turn with narration instead of action or an update_goal call", () => {
		const prompt = buildContinuationPrompt(makeGoal());
		expect(prompt).toMatch(/exactly one/i);
		expect(prompt).toMatch(/status report|done-claim/i);
		expect(prompt).not.toMatch(/wait_for/);
		expect(prompt).not.toMatch(/tmux/i);
	});
});

describe("goal truncation recovery prompt", () => {
	it("stays short and re-injects no objective text or audit blocks", () => {
		const prompt = buildTruncationRecoveryPrompt();
		expect(prompt.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(120);
		expect(prompt).not.toContain("<untrusted_objective>");
		expect(prompt.toLowerCase()).not.toContain("objective");
		expect(prompt.toLowerCase()).not.toContain("audit");
	});

	it("tells the model to continue from the cut point without restarting or restating", () => {
		const prompt = buildTruncationRecoveryPrompt();
		expect(prompt).toMatch(/output[- ]token limit|token limit/i);
		expect(prompt).toMatch(/continue/i);
		expect(prompt).toMatch(/do not restart|not restart|without restarting/i);
		expect(prompt).toMatch(/restate/i);
	});
});

describe("goal stall notice", () => {
	it("emits generic toolless-stall bullets when no monitors are active", () => {
		const notice = buildGoalStallNotice(3, { monitorsActive: false });
		expect(notice).toContain("<goal_stall_check>");
		expect(notice).toContain("</goal_stall_check>");
		expect(notice).toContain("3");
		expect(notice).not.toContain("bash_output");
		expect(notice).not.toContain("kill_bash");
		expect(notice).toMatch(/todo list/i);
		expect(notice).toMatch(/concrete action/i);
		expect(notice).toMatch(/blocked audit/i);
		expect(notice).toMatch(/do not end/i);
	});

	it("keeps the monitor-investigation bullets while monitors are active", () => {
		const notice = buildGoalStallNotice(4, { monitorsActive: true });
		expect(notice).toContain("<goal_stall_check>");
		expect(notice).toContain("bash_output");
		expect(notice).toContain("kill_bash");
		expect(notice).toContain("4");
	});

	it("keeps buildMonitorStallNotice as a legacy wrapper over the generalized notice", () => {
		const legacy = buildMonitorStallNotice(5);
		expect(legacy).toContain("<goal_stall_check>");
		expect(legacy).toBe(buildGoalStallNotice(5, { monitorsActive: true }));
	});
});

describe("goal status UI", () => {
	it("derives status text for each state", () => {
		expect(goalStatusText(makeGoal({ status: "active", timeUsedSeconds: 0 }))).toBe("Pursuing goal");
		expect(goalStatusText(makeGoal({ status: "active", timeUsedSeconds: 65 }))).toBe("Pursuing goal (1m)");
		expect(goalStatusText(makeGoal({ status: "paused" }))).toBe("Goal paused (/goal resume)");
		expect(goalStatusText(makeGoal({ status: "blocked", blockedReason: "Waiting for review", blockedAt: 1 }))).toBe(
			"Goal blocked: Waiting for review",
		);
		expect(goalStatusText(makeGoal({ status: "complete" }))).toBe("Ship the feature \u00b7 Goal achieved");
		expect(goalStatusText(makeGoal({ status: "complete", timeUsedSeconds: 125 }))).toBe(
			"Ship the feature \u00b7 Goal achieved (2m)",
		);
	});

	it("truncates a long objective in the achieved footer", () => {
		const objective = "Refactor the entire session persistence layer to support branching";
		const text = goalStatusText(makeGoal({ status: "complete", objective, timeUsedSeconds: 61 }));
		expect(text).toBe(`${truncateGoalObjective(objective)} \u00b7 Goal achieved (1m)`);
		expect(truncateGoalObjective(objective).length).toBeLessThanOrEqual(32);
		expect(truncateGoalObjective(objective).endsWith("\u2026")).toBe(true);
	});

	it("renders live elapsed seconds for an active goal, ignoring it otherwise", () => {
		expect(goalStatusText(makeGoal({ status: "active", timeUsedSeconds: 0 }), 0)).toBe("Pursuing goal (0s)");
		expect(goalStatusText(makeGoal({ status: "active", timeUsedSeconds: 5 }), 42)).toBe("Pursuing goal (42s)");
		expect(goalStatusText(makeGoal({ status: "paused" }), 99)).toBe("Goal paused (/goal resume)");
		expect(goalStatusText(makeGoal({ status: "complete" }), 99)).toBe("Ship the feature \u00b7 Goal achieved");
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
