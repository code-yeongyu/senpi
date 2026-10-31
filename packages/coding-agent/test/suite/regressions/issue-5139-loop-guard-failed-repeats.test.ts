import { describe, expect, it } from "vitest";
import { createLoopGuardHarness, isRecord, type LoopGuardHarness } from "../loop-guard-test-harness.ts";

// senpi#5139: argument validation throws before `tool_call`, so a call that keeps failing validation never
// reaches the loop guard's blocking hook. The guard must count identical failed calls from tool_execution_end.

async function failedAttempt(
	harness: LoopGuardHarness,
	toolCallId: string,
	toolName: string,
	args: Record<string, unknown>,
	isError = true,
): Promise<void> {
	await harness.fire("tool_execution_start", { type: "tool_execution_start", toolCallId, toolName, args });
	await harness.fire("tool_execution_end", {
		type: "tool_execution_end",
		toolCallId,
		toolName,
		result: { content: [{ type: "text", text: isError ? "Validation failed for tool" : "ok" }], details: {} },
		isError,
	});
	await harness.fire("turn_end", { type: "turn_end", message: { role: "assistant", content: [] }, toolResults: [] });
}

function failedRepeatWarnings(harness: LoopGuardHarness): unknown[] {
	return harness.customMessages
		.filter(({ customType }) => customType === "loop-guard:notice")
		.map(({ details }) => details)
		.filter((details) => isRecord(details) && details.kind === "failed");
}

function aborts(harness: LoopGuardHarness): number {
	return harness.actions.filter((action) => action === "abort:system").length;
}

describe("loop guard: identical calls that keep failing (senpi#5139)", () => {
	it("warns at the third identical failure and stops the turn at the sixth", async () => {
		const harness = createLoopGuardHarness();
		const args = { code: "1" };

		await failedAttempt(harness, "call-1", "eval", args);
		await failedAttempt(harness, "call-2", "eval", args);
		expect(failedRepeatWarnings(harness)).toHaveLength(0);

		await failedAttempt(harness, "call-3", "eval", args);
		expect(failedRepeatWarnings(harness)).toEqual([{ kind: "failed", toolName: "eval", count: 3 }]);
		expect(harness.customMessages.at(-1)).toMatchObject({ triggerTurn: false, deliverAs: "steer" });

		await failedAttempt(harness, "call-4", "eval", args);
		await failedAttempt(harness, "call-5", "eval", args);
		expect(aborts(harness)).toBe(0);

		await failedAttempt(harness, "call-6", "eval", args);
		expect(aborts(harness)).toBe(1);
		expect(harness.actions).toContain("wake-source:1");
		const escalations = harness.customMessages.filter(({ customType }) => customType === "loop-guard:escalation");
		expect(escalations).toMatchObject([
			{
				display: true,
				triggerTurn: false,
				deliverAs: "steer",
				details: { reason: "failed-repeats", toolName: "eval", failedCallCount: 6 },
			},
		]);

		await harness.fire("agent_settled", { type: "agent_settled" });
		expect(harness.actions.at(-1)).toBe("recovery-turn");
	});

	it("never stops alternating different failing calls", async () => {
		const harness = createLoopGuardHarness();
		for (let index = 1; index <= 12; index++) {
			await failedAttempt(harness, `call-${index}`, "eval", { code: index % 2 === 0 ? "a" : "b" });
		}

		expect(failedRepeatWarnings(harness)).toHaveLength(0);
		expect(aborts(harness)).toBe(0);
	});

	it("restarts the count after a successful result", async () => {
		const harness = createLoopGuardHarness();
		const args = { code: "1" };
		for (let index = 1; index <= 5; index++) await failedAttempt(harness, `before-${index}`, "eval", args);
		await failedAttempt(harness, "success", "eval", args, false);
		for (let index = 1; index <= 5; index++) await failedAttempt(harness, `after-${index}`, "eval", args);
		expect(aborts(harness)).toBe(0);

		await failedAttempt(harness, "after-6", "eval", args);
		expect(aborts(harness)).toBe(1);
	});
});
