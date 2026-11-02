import { describe, expect, it } from "vitest";
import { attempt, createLoopGuardHarness } from "./loop-guard-test-harness.ts";

describe("loop-guard hard-stop ownership", () => {
	it("holds the Goal wake-source lease after a repeated hard stop until real input", async () => {
		const harness = createLoopGuardHarness();
		for (let index = 1; index <= 9; index++) {
			await attempt(harness, `call-${index}`, "todo", { op: "view" });
		}
		await harness.fire("agent_settled", { type: "agent_settled" });
		await harness.fire("agent_start", { type: "agent_start" });
		harness.actions.length = 0;

		await attempt(harness, "call-10", "todo", { op: "view" });

		expect(harness.actions).toEqual(["wake-source:1", "continuation-hold:1", "abort:system"]);
		const recoveryCount = harness.customMessages.filter(
			({ customType }) => customType === "loop-guard:recovery",
		).length;
		await harness.fire("agent_settled", { type: "agent_settled" });
		expect(harness.customMessages.filter(({ customType }) => customType === "loop-guard:recovery")).toHaveLength(
			recoveryCount,
		);
		await harness.fire("input", { type: "input", text: "resume", source: "interactive" });
		expect(harness.actions).toEqual([
			"wake-source:1",
			"continuation-hold:1",
			"abort:system",
			"wake-source:0",
			"continuation-hold:0",
		]);
	});

	it("clears pending recovery and the wake-source lease when the signature changes", async () => {
		const harness = createLoopGuardHarness();
		for (let index = 1; index <= 9; index++) {
			await attempt(harness, `call-${index}`, "todo", { op: "view" });
		}
		expect(harness.actions).toContain("wake-source:1");

		await harness.fire("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "changed-call",
			toolName: "read",
			args: { path: "different.ts" },
		});
		await harness.fire("agent_settled", { type: "agent_settled" });

		expect(harness.actions).toContain("wake-source:0");
		expect(harness.customMessages.filter(({ customType }) => customType === "loop-guard:recovery")).toHaveLength(0);
	});

	it("clears the terminal hold when the signature changes after a repeated hard stop", async () => {
		const harness = createLoopGuardHarness();
		for (let index = 1; index <= 9; index++) {
			await attempt(harness, `call-${index}`, "todo", { op: "view" });
		}
		await harness.fire("agent_settled", { type: "agent_settled" });
		await harness.fire("agent_start", { type: "agent_start" });
		harness.actions.length = 0;
		await attempt(harness, "call-10", "todo", { op: "view" });
		expect(harness.actions).toContain("continuation-hold:1");

		await harness.fire("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "changed-after-hard-stop",
			toolName: "read",
			args: { path: "different.ts" },
		});

		expect(harness.actions).toContain("wake-source:0");
		expect(harness.actions).toContain("continuation-hold:0");
	});
});
