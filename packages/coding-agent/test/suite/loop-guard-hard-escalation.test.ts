import { describe, expect, it } from "vitest";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import { attempt, createLoopGuardHarness, isRecord } from "./loop-guard-test-harness.ts";

describe("loop-guard hard escalation", () => {
	it("runs before hooks and permission policy so its block wins first", () => {
		expect(builtinExtensions.slice(0, 3).map(({ id }) => id)).toEqual(["loop-guard", "hooks", "permission-system"]);
	});

	it("blocks the next identical call after admitting the second-notice call", async () => {
		const harness = createLoopGuardHarness();
		for (let index = 1; index <= 6; index++) {
			expect(await attempt(harness, `call-${index}`, "todo", { op: "view" })).toBeUndefined();
		}

		const blocked = await attempt(harness, "call-7", "todo", { op: "view" });

		expect(blocked).toMatchObject({ block: true, terminate: false });
		expect(isRecord(blocked)).toBe(true);
		if (!isRecord(blocked)) return;
		expect(typeof blocked.reason).toBe("string");
		expect(blocked.reason).not.toMatch(/\babort(?:ed)?\b/i);
	});

	it("clears the active block when the tool arguments change", async () => {
		const harness = createLoopGuardHarness();
		for (let index = 1; index <= 6; index++) {
			await attempt(harness, `call-${index}`, "read", { path: "a.ts" });
		}
		expect(await attempt(harness, "call-7", "read", { path: "a.ts" })).toMatchObject({ block: true });

		expect(await attempt(harness, "call-8", "read", { path: "b.ts" })).toBeUndefined();
	});

	it("does not block a tool_call without a correlated execution-start event", async () => {
		const harness = createLoopGuardHarness();
		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolCallId: "bridge-call",
				toolName: "todo",
				input: { op: "view" },
			}),
		).toBeUndefined();
	});

	it("hard-stops on the third blocked call and queues the user wake after settlement", async () => {
		const harness = createLoopGuardHarness();
		for (let index = 1; index <= 6; index++) {
			await attempt(harness, `call-${index}`, "todo", { op: "view" });
		}
		await attempt(harness, "call-7", "todo", { op: "view" });
		await attempt(harness, "call-8", "todo", { op: "view" });

		const hardStop = await attempt(harness, "call-9", "todo", { op: "view" });

		expect(hardStop).toMatchObject({ block: true, terminate: false });
		expect(harness.actions).toEqual(["wake-source:1", "warning", "abort:system"]);
		expect(harness.userMessages).toHaveLength(0);
		await harness.fire("agent_settled", { type: "agent_settled" });
		expect(harness.actions).toEqual(["wake-source:1", "warning", "abort:system", "recovery-turn"]);
		await harness.fire("agent_start", { type: "agent_start" });
		expect(harness.actions).toEqual(["wake-source:1", "warning", "abort:system", "recovery-turn", "wake-source:0"]);
		expect(harness.userMessages).toHaveLength(0);
		expect(harness.customMessages.filter(({ customType }) => customType === "loop-guard:escalation")).toMatchObject([
			{
				customType: "loop-guard:escalation",
				display: true,
				triggerTurn: false,
				deliverAs: "steer",
			},
		]);
		expect(harness.customMessages.filter(({ customType }) => customType === "loop-guard:recovery")).toEqual([
			{
				customType: "loop-guard:recovery",
				display: false,
				triggerTurn: true,
				deliverAs: undefined,
			},
		]);
		expect(harness.renderers.has("loop-guard:escalation")).toBe(true);
	});

	it("repeats only wake-source ownership and system abort after the warning", async () => {
		const harness = createLoopGuardHarness();
		for (let index = 1; index <= 9; index++) {
			await attempt(harness, `call-${index}`, "todo", { op: "view" });
		}
		await harness.fire("agent_settled", { type: "agent_settled" });
		await harness.fire("agent_start", { type: "agent_start" });
		harness.actions.length = 0;

		expect(await attempt(harness, "call-10", "todo", { op: "view" })).toMatchObject({
			block: true,
			terminate: false,
		});
		expect(harness.actions).toEqual(["wake-source:1", "continuation-hold:1", "abort:system"]);
		expect(harness.userMessages).toHaveLength(0);
		expect(harness.customMessages.filter(({ customType }) => customType === "loop-guard:escalation")).toHaveLength(1);
		expect(harness.customMessages.filter(({ customType }) => customType === "loop-guard:recovery")).toHaveLength(1);
	});

	it("does not apply a loop block to an uncorrelated sibling tool call", async () => {
		const harness = createLoopGuardHarness();
		for (let index = 1; index <= 6; index++) {
			await attempt(harness, `call-${index}`, "todo", { op: "view" });
		}
		await harness.fire("tool_execution_start", {
			type: "tool_execution_start",
			toolCallId: "loop-call",
			toolName: "todo",
			args: { op: "view" },
		});

		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolCallId: "sibling-call",
				toolName: "read",
				input: { path: "a.ts" },
			}),
		).toBeUndefined();
		expect(
			await harness.fire("tool_call", {
				type: "tool_call",
				toolCallId: "loop-call",
				toolName: "todo",
				input: { op: "view" },
			}),
		).toMatchObject({ block: true });
	});
});
