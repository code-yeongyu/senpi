import { describe, expect, it } from "vitest";
import {
	buildGoalContinuationSignature,
	evaluateGoalContinuation,
	GOAL_CONTINUATION_CAP,
	GOAL_LENGTH_RECOVERY_LIMIT,
	GOAL_REPETITION_HASH_STREAK,
	GOAL_STALL_TOOLLESS_THRESHOLD,
	GOAL_USER_GRACE_DELAY_MS,
	hashAssistantText,
	normalizeAssistantText,
} from "../../src/core/extensions/builtin/goal/continuation.ts";
import type { Goal } from "../../src/core/extensions/builtin/goal/types.ts";

type VerdictInput = Parameters<typeof evaluateGoalContinuation>[0];

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

function makeInput(overrides: Partial<VerdictInput> = {}): VerdictInput {
	return {
		goal: makeGoal(),
		isIdle: true,
		hasPendingMessages: false,
		path: "immediate",
		lastStopReason: "stop",
		consecutiveContinuations: 0,
		lastContinuationSignature: undefined,
		currentSignature: "goal-1:1/2:abc123",
		consecutiveLengthRecoveries: 0,
		recentNormalizedOutputHashes: [],
		toollessContinuationStreak: 0,
		continuationPending: false,
		...overrides,
	};
}

describe("goal continuation verdict", () => {
	it.each([
		[
			"requires an active immediate goal with no pending messages and a clean end",
			makeInput({ goal: makeGoal({ status: "paused" }) }),
		],
		["rejects an immediate path with pending messages", makeInput({ hasPendingMessages: true })],
		["rejects an immediate path after an unclean end", makeInput({ lastStopReason: "error" })],
		["requires idle state for monitor-delayed continuation", makeInput({ path: "monitorDelayed", isIdle: false })],
		["requires idle state for user-grace continuation", makeInput({ path: "userGrace", isIdle: false })],
		["requires idle state for session-start continuation", makeInput({ path: "sessionStart", isIdle: false })],
	] as const)("denies as not eligible when %s", (_label, input) => {
		expect(evaluateGoalContinuation(input)).toEqual({ kind: "deny", reason: "not-eligible" });
	});

	it.each([
		["single-flight", makeInput({ continuationPending: true })],
		[
			"cap",
			makeInput({
				consecutiveContinuations: GOAL_CONTINUATION_CAP,
			}),
		],
		[
			"stale",
			makeInput({
				lastContinuationSignature: "goal-1:1/2:abc123",
			}),
		],
		[
			"repetition",
			makeInput({
				recentNormalizedOutputHashes: ["same", "same", "same"],
			}),
		],
		[
			"length-exhausted",
			makeInput({
				lastStopReason: "length",
				consecutiveLengthRecoveries: GOAL_LENGTH_RECOVERY_LIMIT,
			}),
		],
	] as const)("denies with %s", (reason, input) => {
		expect(evaluateGoalContinuation(input)).toEqual({ kind: "deny", reason });
	});

	it("admits below the continuation cap and denies at the boundary", () => {
		expect(
			evaluateGoalContinuation(makeInput({ consecutiveContinuations: GOAL_CONTINUATION_CAP - 1 })),
		).toMatchObject({ kind: "continue" });
		expect(evaluateGoalContinuation(makeInput({ consecutiveContinuations: GOAL_CONTINUATION_CAP }))).toEqual({
			kind: "deny",
			reason: "cap",
		});
	});

	it.each([
		["a clean ordinary end", makeInput(), { kind: "continue", prompt: "full", stallNotice: false }],
		[
			"the first output truncation",
			makeInput({ lastStopReason: "length" }),
			{ kind: "continue", prompt: "minimal", stallNotice: false },
		],
	] as const)("continues with %s using the correct prompt", (_label, input, verdict) => {
		expect(evaluateGoalContinuation(input)).toEqual(verdict);
	});

	it("preserves per-path eligibility semantics", () => {
		expect(evaluateGoalContinuation(makeInput({ isIdle: false }))).toMatchObject({ kind: "continue" });
		expect(evaluateGoalContinuation(makeInput({ path: "monitorDelayed", lastStopReason: "error" }))).toMatchObject({
			kind: "continue",
		});
		expect(evaluateGoalContinuation(makeInput({ path: "userGrace", lastStopReason: "error" }))).toMatchObject({
			kind: "continue",
		});
		expect(evaluateGoalContinuation(makeInput({ path: "sessionStart", lastStopReason: "error" }))).toMatchObject({
			kind: "continue",
		});
		expect(
			evaluateGoalContinuation(makeInput({ path: "systemRecovery", isIdle: false, lastStopReason: "error" })),
		).toMatchObject({ kind: "continue" });
	});

	it("applies the cap to every remaining automatic continuation path", () => {
		const capped = makeInput({
			consecutiveContinuations: GOAL_CONTINUATION_CAP,
			lastContinuationSignature: "goal-1:1/2:abc123",
		});

		for (const path of ["immediate", "monitorDelayed", "userGrace", "sessionStart", "systemRecovery"] as const) {
			expect(evaluateGoalContinuation({ ...capped, path })).toEqual({ kind: "deny", reason: "cap" });
		}
		expect(
			evaluateGoalContinuation({
				...capped,
				path: "monitorDelayed",
				consecutiveContinuations: GOAL_CONTINUATION_CAP - 1,
			}),
		).toMatchObject({ kind: "continue" });
		expect(
			evaluateGoalContinuation({
				...capped,
				path: "sessionStart",
				consecutiveContinuations: GOAL_CONTINUATION_CAP - 1,
			}),
		).toMatchObject({ kind: "continue" });
	});

	it.each([
		["single-flight", { continuationPending: true }],
		["cap", { consecutiveContinuations: GOAL_CONTINUATION_CAP }],
		["repetition", { recentNormalizedOutputHashes: ["same", "same", "same"] }],
	] as const)("keeps the %s guard on system recovery", (reason, overrides) => {
		expect(
			evaluateGoalContinuation(
				makeInput({ path: "systemRecovery", isIdle: false, lastStopReason: "error", ...overrides }),
			),
		).toEqual({ kind: "deny", reason });
	});

	it.each([
		[GOAL_STALL_TOOLLESS_THRESHOLD - 1, false],
		[GOAL_STALL_TOOLLESS_THRESHOLD, true],
		[GOAL_STALL_TOOLLESS_THRESHOLD + 1, true],
	] as const)("sets stall notice to %s at a toolless streak of %i", (toollessContinuationStreak, stallNotice) => {
		expect(evaluateGoalContinuation(makeInput({ toollessContinuationStreak }))).toEqual({
			kind: "continue",
			prompt: "full",
			stallNotice,
		});
	});

	it("normalizes assistant text and hashes its normalized form stably", () => {
		expect(normalizeAssistantText("  Hello\tWORLD\nagain  ")).toBe("hello world again");
		expect(normalizeAssistantText(" \n\t ")).toBe("");
		expect(hashAssistantText("Hello\nworld")).toBe(hashAssistantText("  hello   WORLD "));
		expect(hashAssistantText("Hello world")).not.toBe(hashAssistantText("Goodbye world"));
		expect(hashAssistantText("Hello world")).toBe("d58b3fa7");
	});

	it("builds a progress signature without goal.updatedAt", () => {
		const hash = hashAssistantText("Made progress");
		expect(buildGoalContinuationSignature(makeGoal({ updatedAt: 1 }), 2, 5, hash)).toBe(`goal-1:2/5:${hash}`);
		expect(buildGoalContinuationSignature(makeGoal({ updatedAt: 9_999 }), 2, 5, hash)).toBe(`goal-1:2/5:${hash}`);
	});

	it("keeps the public policy constants at their specified values", () => {
		expect(GOAL_CONTINUATION_CAP).toBe(8);
		expect(GOAL_STALL_TOOLLESS_THRESHOLD).toBe(3);
		expect(GOAL_REPETITION_HASH_STREAK).toBe(3);
		expect(GOAL_LENGTH_RECOVERY_LIMIT).toBe(1);
		expect(GOAL_USER_GRACE_DELAY_MS).toBe(10_000);
	});
});
