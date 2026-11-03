import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveModelScopeFromModels } from "../src/core/model-resolver.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function model(provider: string, id: string): Model<"anthropic-messages"> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 4096,
	};
}

const models = [
	model("anthropic", "claude-sonnet-4-5"),
	model("anthropic", "claude-opus-4-1"),
	model("openai", "gpt-4o"),
	model("openrouter", "qwen/qwen3-coder:exacto"),
	model("openrouter", "openai/gpt-4o:extended"),
];

describe("model scope globs (minimatch with nocase)", () => {
	const cases: Array<{ pattern: string; expected: string[]; thinkingLevel?: string }> = [
		{ pattern: "ANTHROPIC/*", expected: ["anthropic/claude-opus-4-1", "anthropic/claude-sonnet-4-5"] },
		{ pattern: "*SONNET*", expected: ["anthropic/claude-sonnet-4-5"] },
		{ pattern: "claude-[so]*", expected: ["anthropic/claude-opus-4-1", "anthropic/claude-sonnet-4-5"] },
		{ pattern: "claude-?onnet*:high", expected: ["anthropic/claude-sonnet-4-5"], thinkingLevel: "high" },
		{ pattern: "gpt-4o*", expected: ["openai/gpt-4o"] },
		{ pattern: "*/gpt-4o*", expected: ["openai/gpt-4o"] },
		{ pattern: "openrouter/*", expected: [] },
		{
			pattern: "openrouter/**",
			expected: ["openrouter/openai/gpt-4o:extended", "openrouter/qwen/qwen3-coder:exacto"],
		},
		{ pattern: "**/*4o*", expected: ["openai/gpt-4o", "openrouter/openai/gpt-4o:extended"] },
		{
			pattern: "openrouter/{qwen,openai}/*",
			expected: ["openrouter/openai/gpt-4o:extended", "openrouter/qwen/qwen3-coder:exacto"],
		},
	];

	it.each(cases)("$pattern", ({ pattern, expected, thinkingLevel }) => {
		const { scopedModels } = resolveModelScopeFromModels([pattern], models);
		expect(scopedModels.map((entry) => `${entry.model.provider}/${entry.model.id}`).sort()).toEqual(expected);
		if (thinkingLevel !== undefined) {
			expect(scopedModels.every((entry) => entry.thinkingLevel === thinkingLevel)).toBe(true);
		}
	});
});

describe("resource filter globs (minimatch, case-sensitive)", () => {
	let tempDir: string;
	let agentDir: string;
	let settingsManager: SettingsManager;
	let packageManager: DefaultPackageManager;

	beforeEach(() => {
		tempDir = join(tmpdir(), `minimatch-call-sites-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		// The real agent dir sits under a dot directory (~/.senpi/agent); absolute-path matching must keep working there.
		agentDir = join(tempDir, ".senpi", "agent");
		const promptsDir = join(agentDir, "prompts");
		mkdirSync(join(promptsDir, "sub", "deep"), { recursive: true });
		for (const file of [
			"keep.md",
			"remove.md",
			"alpha.md",
			"beta.md",
			join("sub", "inner.md"),
			join("sub", "deep", "leaf.md"),
		]) {
			writeFileSync(join(promptsDir, file), "prompt");
		}
		settingsManager = SettingsManager.inMemory();
		packageManager = new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	const all = ["alpha.md", "beta.md", "keep.md", "remove.md", "sub/deep/leaf.md", "sub/inner.md"];
	const without = (...names: string[]) => all.filter((name) => !names.includes(name));
	const cases: Array<{ exclude: string | ((agent: string) => string); enabled: string[] }> = [
		{ exclude: "remove.md", enabled: without("remove.md") },
		{ exclude: "REMOVE.md", enabled: all },
		{ exclude: "**/remove.md", enabled: without("remove.md") },
		{ exclude: "prompts/sub/*.md", enabled: without("sub/inner.md") },
		{ exclude: "prompts/sub/**", enabled: without("sub/inner.md", "sub/deep/leaf.md") },
		{ exclude: "**/sub/**", enabled: without("sub/inner.md", "sub/deep/leaf.md") },
		{ exclude: "{alpha,beta}.md", enabled: without("alpha.md", "beta.md") },
		{ exclude: "*.md", enabled: [] },
		{ exclude: (agent) => `${agent}/prompts/keep.md`, enabled: without("keep.md") },
		{ exclude: (agent) => `${agent}/prompts/**/*.md`, enabled: [] },
		{ exclude: (agent) => `${agent.split("/.senpi/")[0]}/**/keep.md`, enabled: all },
	];

	it.each(cases)("!$exclude", async ({ exclude, enabled }) => {
		const posixAgentDir = agentDir.replace(/\\/g, "/");
		const pattern = typeof exclude === "string" ? exclude : exclude(posixAgentDir);
		settingsManager.setPromptTemplatePaths(["prompts", `!${pattern}`]);

		const result = await packageManager.resolve();
		const promptsRoot = `${posixAgentDir}/prompts/`;
		const local = result.prompts.filter((resource) => resource.path.replace(/\\/g, "/").startsWith(promptsRoot));
		expect(local.map((resource) => resource.path.replace(/\\/g, "/").slice(promptsRoot.length)).sort()).toEqual(all);
		expect(
			local
				.filter((resource) => resource.enabled)
				.map((resource) => resource.path.replace(/\\/g, "/").slice(promptsRoot.length))
				.sort(),
		).toEqual(enabled);
	});
});
