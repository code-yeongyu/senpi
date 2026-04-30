import type { Api, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { buildDynamicSystemPrompt } from "../../src/core/dynamic-prompt/build.js";
import { type PromptPresetSettings, resolvePreset } from "../../src/core/extensions/builtin/prompt-preset/presets.js";

function createModel(id: string, provider: string, api: Api = "openai-responses"): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

function fallbackPrompt(): string {
	return buildDynamicSystemPrompt({
		cwd: "/repo",
		selectedTools: ["read", "bash", "edit", "write"],
		toolSnippets: {
			read: "Read file contents",
			bash: "Execute shell commands",
			edit: "Edit existing files",
			write: "Write files",
		},
		promptGuidelines: ["Use read before edit."],
		contextFiles: [{ path: "/repo/AGENTS.md", content: "Follow project conventions." }],
		skills: [],
	});
}

describe("prompt preset resolver", () => {
	it.each([
		{ id: "gpt-5.4", provider: "openai", api: "openai-responses" as const },
		{ id: "gpt-5.5", provider: "openai-codex", api: "openai-codex-responses" as const },
	])("returns hephaestus preset for $provider/$id", ({ id, provider, api }) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(id, provider, api);

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("hephaestus");
		expect(preset?.prompt).toContain("# Stop Rules");
		expect(preset?.prompt).toContain("You are Hephaestus");
		expect(preset?.prompt.length).toBeGreaterThan(4_000);
	});

	it.each([
		{ id: "moonshotai/kimi-k2.6", provider: "kimi" },
		{ id: "claude-opus-4-7", provider: "anthropic" },
		{ id: "claude-opus-4-6", provider: "anthropic" },
		{ id: "us.anthropic.claude-opus-4-6-v1", provider: "amazon-bedrock", api: "bedrock-converse-stream" as const },
	])("returns sisyphus preset for $provider/$id", ({ id, provider, api }) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(id, provider, api ?? "anthropic-messages");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("sisyphus");
		expect(preset?.prompt).toContain("<intent>");
		expect(preset?.prompt).toContain("You are Sisyphus");
		expect(preset?.prompt.length).toBeGreaterThan(4_000);
	});

	it.each([
		{ id: "gpt-5.6", provider: "openai" },
		{ id: "claude-sonnet-4-5", provider: "anthropic", api: "anthropic-messages" as const },
	])("returns undefined so senpi-current remains unchanged for $provider/$id", ({ id, provider, api }) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(id, provider, api ?? "openai-responses");
		const currentPrompt = fallbackPrompt();

		// when
		const preset = resolvePreset(model, settings);
		const activePrompt = preset?.prompt ?? currentPrompt;

		// then
		expect(preset).toBeUndefined();
		expect(activePrompt).toBe(currentPrompt);
		expect(activePrompt.length).toBe(currentPrompt.length);
		expect(activePrompt).toContain("## Available Tools");
		expect(activePrompt).toContain("Current working directory: /repo");
	});

	it("allows settings.json to force sisyphus regardless of model id", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "sisyphus" };
		const model = createModel("gpt-5.5", "openai-codex", "openai-codex-responses");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("sisyphus");
		expect(preset?.prompt).toContain("<intent>");
	});

	it("allows settings.json to force hephaestus regardless of model id", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "hephaestus" };
		const model = createModel("claude-opus-4-7", "anthropic", "anthropic-messages");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("hephaestus");
		expect(preset?.prompt).toContain("# Stop Rules");
	});
});
