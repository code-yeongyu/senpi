import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { APP_NAME } from "../src/config.ts";
import type { BuildDynamicSystemPromptOptions } from "../src/core/dynamic-prompt/build.ts";
import { buildIdentitySection } from "../src/core/dynamic-prompt/identity.ts";
import { buildClaudeFable5Prompt } from "../src/core/extensions/builtin/prompt-preset/claude-fable-5.ts";
import { buildClaudeOpus5Prompt } from "../src/core/extensions/builtin/prompt-preset/claude-opus-5.ts";
import { buildGpt55Prompt } from "../src/core/extensions/builtin/prompt-preset/gpt-5.5.ts";
import { buildGpt56Prompt } from "../src/core/extensions/builtin/prompt-preset/gpt-5.6.ts";
import { buildGrok45Prompt } from "../src/core/extensions/builtin/prompt-preset/grok-4.5.ts";
import { buildKimiK3Prompt } from "../src/core/extensions/builtin/prompt-preset/kimi-k3.ts";

const OPTIONS: BuildDynamicSystemPromptOptions = {
	cwd: "/test/project",
	selectedTools: ["read", "bash", "edit", "write"],
	toolSnippets: {
		read: "Read file contents",
		bash: "Execute shell commands",
		edit: "Apply surgical edits",
		write: "Create or overwrite files",
	},
	promptGuidelines: [],
	contextFiles: [],
	skills: [],
};

const PRESET_FILES = [
	"claude-fable-5.ts",
	"claude-opus-5.ts",
	"gpt-5.5.ts",
	"gpt-5.6.ts",
	"grok-4.5.ts",
	"kimi-k3.ts",
] as const;

const PRESET_BUILDERS = [
	["claude-fable-5", buildClaudeFable5Prompt],
	["claude-opus-5", buildClaudeOpus5Prompt],
	["gpt-5.5", buildGpt55Prompt],
	["gpt-5.6", buildGpt56Prompt],
	["grok-4.5", buildGrok45Prompt],
	["kimi-k3", buildKimiK3Prompt],
] as const;

describe("agent identity", () => {
	test("names the running product instead of a hardcoded brand", () => {
		expect(buildIdentitySection()).toBe(
			`You are ${APP_NAME}, a coding agent. Your work should be indistinguishable from a careful senior engineer's.`,
		);
	});

	test("a standalone install still identifies as senpi", () => {
		expect(APP_NAME).toBe("senpi");
		expect(buildIdentitySection()).toContain("You are senpi");
	});
});

describe("prompt presets", () => {
	for (const [name, build] of PRESET_BUILDERS) {
		test(`${name} opens with the running product name`, () => {
			expect(build(OPTIONS)).toContain(`You are ${APP_NAME}`);
		});
	}

	test("grok-4.5 spawns workers through the running product's own command", () => {
		const prompt = buildGrok45Prompt(OPTIONS);

		expect(prompt).toContain(`${APP_NAME} --print`);
	});

	test("no prompt source hardcodes the product name", () => {
		const sources = [
			readFileSync(new URL("../src/core/dynamic-prompt/identity.ts", import.meta.url), "utf-8"),
			...PRESET_FILES.map((file) =>
				readFileSync(new URL(`../src/core/extensions/builtin/prompt-preset/${file}`, import.meta.url), "utf-8"),
			),
		];

		for (const source of sources) {
			const promptText = source.split("\n").filter((line) => !line.trimStart().startsWith("//"));

			expect(promptText.join("\n")).not.toMatch(/You are senpi|`senpi --print/);
		}
	});
});
