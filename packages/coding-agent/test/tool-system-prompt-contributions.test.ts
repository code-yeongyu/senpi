import { describe, expect, test } from "vitest";
import { buildDynamicSystemPrompt } from "../src/core/dynamic-prompt/build.ts";
import { buildSystemPrompt } from "../src/core/system-prompt.ts";
import { bashToolSystemPromptContribution, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createEditToolDefinition, editToolSystemPromptContribution } from "../src/core/tools/edit.ts";
import { createFindToolDefinition, findToolSystemPromptContribution } from "../src/core/tools/find.ts";
import { createGrepToolDefinition, grepToolSystemPromptContribution } from "../src/core/tools/grep.ts";
import { createLsToolDefinition, lsToolSystemPromptContribution } from "../src/core/tools/ls.ts";
import {
	createPowerShellToolDefinition,
	powershellToolSystemPromptContribution,
} from "../src/core/tools/powershell.ts";
import { createReadToolDefinition, readToolSystemPromptContribution } from "../src/core/tools/read.ts";
import { createWriteToolDefinition, writeToolSystemPromptContribution } from "../src/core/tools/write.ts";

const cases = [
	["read", readToolSystemPromptContribution, createReadToolDefinition],
	["bash", bashToolSystemPromptContribution, createBashToolDefinition],
	["powershell", powershellToolSystemPromptContribution, createPowerShellToolDefinition],
	["edit", editToolSystemPromptContribution, createEditToolDefinition],
	["write", writeToolSystemPromptContribution, createWriteToolDefinition],
	["grep", grepToolSystemPromptContribution, createGrepToolDefinition],
	["find", findToolSystemPromptContribution, createFindToolDefinition],
	["ls", lsToolSystemPromptContribution, createLsToolDefinition],
] as const;

describe("built-in tool system prompt contributions", () => {
	test.each(cases)(
		"keeps the %s tool definition aligned with its contribution",
		(_name, contribution, createDefinition) => {
			const definition = createDefinition("/workspace");

			expect(definition.promptSnippet).toBe(contribution.snippet);
			expect(definition.promptGuidelines ?? []).toEqual(contribution.guidelines);
		},
	);

	test.each([{ selectedTools: ["eval"] }, { selectedTools: ["bash", "eval"] }])(
		"routes contributed grep through eval with selected tools $selectedTools",
		({ selectedTools }) => {
			const options = {
				cwd: "/workspace",
				selectedTools,
				toolSnippets: {
					grep: grepToolSystemPromptContribution.snippet,
					bash: bashToolSystemPromptContribution.snippet,
					eval: "Evaluate code",
				},
				promptGuidelines: [],
				contextFiles: [],
				skills: [],
			};
			const legacy = buildSystemPrompt(options);
			const dynamic = buildDynamicSystemPrompt(options);
			const grepGuideline = legacy.split("\n").find((line) => line.includes("tool.grep("));
			expect(
				grepGuideline
					?.match(/tool\.grep\(\{\s*([^}]+)\s*\}\)/)?.[1]
					.split(",")
					.map((key) => key.trim()),
			).toEqual(["pattern", "path"]);
			expect(dynamic.split("\n")).toContain(grepGuideline);
			for (const prompt of [legacy, dynamic]) {
				expect(prompt).not.toMatch(/^- grep:/m);
				if (!selectedTools.includes("bash")) expect(prompt).not.toMatch(/^- bash:/m);
			}

			// Compare the shipped fallback bullet, not its wording.
			const noTools = buildSystemPrompt({ ...options, selectedTools: [], toolSnippets: {} });
			const shellOnly = buildSystemPrompt({ ...options, selectedTools: ["bash"], toolSnippets: {} });
			const shellGuidelines = shellOnly
				.split("\n")
				.filter((line) => line.startsWith("- ") && !noTools.split("\n").includes(line));
			expect(shellGuidelines).toHaveLength(1);
			for (const guideline of shellGuidelines) {
				expect(legacy.split("\n")).not.toContain(guideline);
				expect(dynamic.split("\n")).not.toContain(guideline);
			}
		},
	);

	test.each([
		["bash", createBashToolDefinition],
		["powershell", createPowerShellToolDefinition],
	] as const)("keeps %s session-environment guidance conditional", (_name, createDefinition) => {
		const definition = createDefinition("/workspace", { exposeSessionEnvironment: false });

		expect(definition.promptGuidelines).toBeUndefined();
	});
});
