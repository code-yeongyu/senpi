import { describe, expect, it } from "vitest";
import { buildBashTimeoutPrompt } from "../../src/core/extensions/builtin/bash-timeout/timeout.ts";
import { buildContinuationPrompt } from "../../src/core/extensions/builtin/goal/prompt.ts";
import { registerGoalTools } from "../../src/core/extensions/builtin/goal/tool-registration.ts";
import { buildTerminalPromptSection } from "../../src/core/extensions/builtin/terminal/prompt.ts";
import { TASK_MANAGEMENT_SECTION, TODO_TOOL_DESCRIPTION } from "../../src/core/extensions/builtin/todotools/prompt.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";

function registeredToolDescriptions(): Map<string, string> {
	const descriptions = new Map<string, string>();
	const pi = {
		registerTool(tool: { name: string; description: string }) {
			descriptions.set(tool.name, tool.description);
		},
	} as unknown as ExtensionAPI;
	registerGoalTools(pi, {
		goalStoreRef: () => {
			throw new Error("not used");
		},
		accountCurrentAgentTurn: async () => null,
		beginAgentGoalAccounting: () => {},
		markGoalBlockedThisTurn: () => {},
		markGoalCompletedThisTurn: () => {},
		refreshGoalUi: () => {},
	});
	return descriptions;
}

function surfacesContaining(surfaces: Record<string, string>, needle: RegExp): string[] {
	return Object.entries(surfaces)
		.filter(([, text]) => needle.test(text))
		.map(([name]) => name);
}

describe("prompt surfaces render each stance in exactly one home", () => {
	it("the todo operations table lives in the tool description, not in the Task_Management section", () => {
		// given
		const surfaces = { toolDescription: TODO_TOOL_DESCRIPTION, taskManagementSection: TASK_MANAGEMENT_SECTION };

		// then
		expect(TASK_MANAGEMENT_SECTION).not.toContain(TODO_TOOL_DESCRIPTION);
		expect(surfacesContaining(surfaces, /^\| op \|/m)).toEqual(["toolDescription"]);
		expect(surfacesContaining(surfaces, /^## Anatomy/m)).toEqual(["toolDescription"]);
	});

	it("the goal audits live in the continuation prompt; update_goal only points at them", () => {
		// given
		const continuation = buildContinuationPrompt({
			objective: "x",
			timeUsedSeconds: 0,
			tokensUsed: 0,
			status: "active",
		} as Parameters<typeof buildContinuationPrompt>[0]);
		const updateGoal = registeredToolDescriptions().get("update_goal") ?? "";
		const surfaces = { continuation, updateGoal };

		// then
		expect(updateGoal.toLowerCase()).toContain("audit");
		expect(surfacesContaining(surfaces, /consecutive/)).toEqual(["continuation"]);
		expect(surfacesContaining(surfaces, /resumption channel/)).toEqual(["continuation"]);
	});

	it("the waiting doctrine lives in the terminal section; the timeout policy covers timeouts only", () => {
		// given
		const timeoutPolicy = buildBashTimeoutPrompt({ defaultSeconds: 1800, maxSeconds: 1800 }, { foregroundWindowSeconds: 60 });
		const surfaces = { timeoutPolicy, terminalSection: buildTerminalPromptSection({ evalOnly: false }) };

		// then
		expect(surfacesContaining(surfaces, /monitor\(/)).toEqual(["terminalSection"]);
		expect(timeoutPolicy).not.toMatch(/\bpoll|\bsleep\b/i);
		expect(surfacesContaining(surfaces, /run_in_background/)).toEqual(["terminalSection"]);
		expect(timeoutPolicy).toContain("kill deadline");
	});
});
