import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { buildDynamicSystemPrompt } from "../../src/core/dynamic-prompt/build.ts";
import {
	type PromptPresetSettings,
	resolvePreset,
	resolvePresetName,
} from "../../src/core/extensions/builtin/prompt-preset/presets.ts";

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

function hasKimiK26CatalogSignal(model: Model<Api>): boolean {
	const searchable = `${model.id} ${model.name}`.toLowerCase().replace(/\s+/g, "-");
	return /(?:^|[/@._-])kimi-k2(?:[._-]|p)6(?:$|[/@._:-])/.test(searchable);
}

function getKimiK26CatalogModels(): Model<Api>[] {
	return getProviders().flatMap((provider) => (getModels(provider) as Model<Api>[]).filter(hasKimiK26CatalogSignal));
}

function hasKimiK27CatalogSignal(model: Model<Api>): boolean {
	const searchable = `${model.id} ${model.name}`.toLowerCase().replace(/\s+/g, "-");
	return /(?:^|[/@._-])kimi-k2(?:[._-]|p)7(?:$|[/@._:-])/.test(searchable);
}

function getKimiK27CatalogModels(): Model<Api>[] {
	return getProviders().flatMap((provider) => (getModels(provider) as Model<Api>[]).filter(hasKimiK27CatalogSignal));
}

describe("prompt preset resolver", () => {
	it.each([
		{
			id: "gpt-5.4",
			provider: "openai",
			api: "openai-responses" as const,
			expectedName: "gpt-5.4" as const,
		},
	])("returns $expectedName preset for $provider/$id", ({ id, provider, api, expectedName }) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(id, provider, api);

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe(expectedName);
		expect(preset?.prompt).toContain("You are senpi");
		expect(preset?.prompt).toContain("reasoning effort");
		expect(preset?.prompt).toContain("## Intent Gate");
		expect(preset?.prompt).toContain("I read this as");
		expect(preset?.prompt.length).toBeGreaterThan(2_000);
	});

	it.each([
		{
			id: "gpt-5.5",
			provider: "openai-codex",
			api: "openai-codex-responses" as const,
		},
		{
			id: "gpt-5.5-pro",
			provider: "openai",
			api: "openai-responses" as const,
		},
	])("returns gpt-5.5 preset for $provider/$id", ({ id, provider, api }) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(id, provider, api);

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("gpt-5.5");
		expect(preset?.prompt).toContain("You are senpi");
		expect(preset?.prompt).toContain("Reason efficiently");
		expect(preset?.prompt).toContain("outcome-first");
		expect(preset?.prompt).toContain("Todo discipline");
		expect(preset?.prompt).toContain("todo");
		expect(preset?.prompt).toContain("Dig deeper");
		expect(preset?.prompt).toContain("decision rules");
		expect(preset?.prompt).toContain("## Intent Gate");
		expect(preset?.prompt).toContain("I read this as");
		// Full-core rewrite: shared-core scaffolding is replaced, dynamic pieces stay.
		expect(preset?.prompt).toContain("## Verification");
		expect(preset?.prompt).toContain("### Test Discipline");
		expect(preset?.prompt).toContain("## Hard Limits");
		expect(preset?.prompt).not.toContain("## Policies");
		expect(preset?.prompt).not.toContain("### Execution Stance");
		expect(preset?.prompt).not.toContain("### Request Classification");
		expect(preset?.prompt.length).toBeGreaterThan(2_000);
	});

	it.each([
		{
			id: "gpt-5.6",
			provider: "openai",
			api: "openai-responses" as const,
		},
		{
			id: "gpt-5.6-sol",
			provider: "openai",
			api: "openai-responses" as const,
		},
		{
			id: "gpt-5.6-terra",
			provider: "openai",
			api: "openai-responses" as const,
		},
		{
			id: "gpt-5.6-luna",
			provider: "openai",
			api: "openai-responses" as const,
		},
		{
			id: "gpt-5.6-sol",
			provider: "openai-codex",
			api: "openai-codex-responses" as const,
		},
		{
			id: "openai/gpt-5.6-terra",
			provider: "openrouter",
			api: "openai-responses" as const,
		},
	])("returns gpt-5.6 preset for $provider/$id", ({ id, provider, api }) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(id, provider, api);

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("gpt-5.6");
		expect(preset?.prompt).toContain("You are senpi");
		expect(preset?.prompt).toContain("## Intent Gate");
		expect(preset?.prompt).toContain("I read this as");
		expect(preset?.prompt).toContain("outcome-first");
		expect(preset?.prompt).toContain("todo");
		expect(preset?.prompt).toContain("reconcile every item");
		// GPT-5.6 tuning: prioritization instead of brevity, tool-loop stopping conditions.
		expect(preset?.prompt).toContain("fewest useful tool loops");
		expect(preset?.prompt).toContain("serial is the exception");
		expect(preset?.prompt).toContain("Lead with the conclusion");
		// Hephaestus parity: autonomous deep-worker contracts.
		expect(preset?.prompt).toContain("Implement, don't propose");
		expect(preset?.prompt).toContain("## Manual QA Gate");
		expect(preset?.prompt).toContain("## Failure Recovery");
		expect(preset?.prompt).toContain("## Pragmatism & Scope");
		expect(preset?.prompt).toContain("## Stop Goal");
		// Binding stop contract: declared per-turn stop condition + mandatory immediate stop.
		expect(preset?.prompt).toContain("I'll stop right away when");
		expect(preset?.prompt).toContain("BINDING");
		expect(preset?.prompt).toContain("STOPPING IS MANDATORY AND IMMEDIATE");
		expect(preset?.prompt).not.toContain("## Stop Rules");
		expect(preset?.prompt).toContain("Never revert or modify changes you did not make");
		// Verification binds to validators senpi can actually run; no phantom diagnostics tool.
		expect(preset?.prompt).toContain("type check");
		expect(preset?.prompt).not.toContain("lsp_diagnostics");
		// omo-only tool contracts must NOT leak into senpi's tool surface.
		expect(preset?.prompt).not.toContain("librarian");
		expect(preset?.prompt).not.toContain("oracle");
		expect(preset?.prompt).not.toContain("background_output");
		expect(preset?.prompt).not.toContain("background_cancel");
		expect(preset?.prompt).not.toContain("update_plan");
		expect(preset?.prompt).not.toContain("interactive_bash");
		expect(preset?.prompt).not.toContain("subagent_type");
		// Full-core rewrite: shared-core scaffolding is replaced, dynamic pieces stay.
		expect(preset?.prompt).toContain("## Verification");
		expect(preset?.prompt).toContain("### Test Discipline");
		expect(preset?.prompt).toContain("## Hard Limits");
		expect(preset?.prompt).not.toContain("## Policies");
		expect(preset?.prompt).not.toContain("### Execution Stance");
		expect(preset?.prompt).not.toContain("### Request Classification");
		expect(preset?.prompt.length).toBeGreaterThan(2_000);
	});

	it("keeps GPT-5.5 on the gpt-5.5 preset, distinct from GPT-5.6", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const gpt55 = resolvePreset(createModel("gpt-5.5", "openai", "openai-responses"), settings);
		const gpt56 = resolvePreset(createModel("gpt-5.6-sol", "openai", "openai-responses"), settings);

		// then
		expect(gpt55?.name).toBe("gpt-5.5");
		expect(gpt55?.prompt).not.toContain("fewest useful tool loops");
		expect(gpt56?.name).toBe("gpt-5.6");
		expect(gpt56?.prompt).not.toContain("Dig deeper");
	});

	it("returns gpt-5.6 preset for every GPT-5.6 built-in catalog model", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const catalogModels = getProviders().flatMap((provider) =>
			(getModels(provider) as Model<Api>[]).filter((model) => model.id.toLowerCase().includes("gpt-5.6")),
		);
		const catalogModelIds = catalogModels.map((model) => `${model.provider}/${model.id}`);

		// when
		const misses = catalogModels
			.filter((model) => resolvePresetName(model, settings) !== "gpt-5.6")
			.map((model) => `${model.provider}/${model.id}`);

		// then
		expect(catalogModelIds).toEqual(
			expect.arrayContaining(["openai/gpt-5.6-sol", "openai-codex/gpt-5.6-sol", "openrouter/openai/gpt-5.6-sol"]),
		);
		expect(misses).toEqual([]);
	});

	it.each([
		{
			id: "claude-opus-4-8",
			provider: "anthropic",
			api: "anthropic-messages" as const,
			expectedName: "claude-opus-4-8",
		},
		{
			id: "claude-opus-4-7",
			provider: "anthropic",
			api: "anthropic-messages" as const,
			expectedName: "claude-opus-4-7",
		},
		{
			id: "claude-opus-4-6",
			provider: "anthropic",
			api: "anthropic-messages" as const,
			expectedName: "claude-opus-4-6",
		},
		{
			id: "us.anthropic.claude-opus-4-6-v1",
			provider: "amazon-bedrock",
			api: "bedrock-converse-stream" as const,
			expectedName: "claude-opus-4-6",
		},
	])("returns $expectedName preset for $provider/$id", ({ id, provider, api, expectedName }) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(id, provider, api);

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe(expectedName);
		expect(preset?.prompt).toContain("You are senpi");
		expect(preset?.prompt).toContain("## Intent Gate");
		expect(preset?.prompt).toContain("I read this as");
		expect(preset?.prompt.length).toBeGreaterThan(2_000);
	});

	it.each([
		{ id: "kimi-k2.6-0528", provider: "moonshot", api: "openai-responses" as const },
		{ id: "kimi-k2p6-turbo", provider: "moonshot", api: "openai-responses" as const },
	])("returns kimi-k2-6 preset for $provider/$id", ({ id, provider, api }) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(id, provider, api);

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("kimi-k2-6");
		expect(preset?.prompt).toContain("You are senpi");
		expect(preset?.prompt).toContain("filler verification language");
		expect(preset?.prompt).toContain("## Intent Gate");
		expect(preset?.prompt.length).toBeGreaterThan(2_000);
	});

	it.each([
		{ id: "kimi-k2.7-0711", provider: "moonshot", api: "openai-responses" as const },
		{ id: "kimi-k2p7-turbo", provider: "moonshot", api: "openai-responses" as const },
		{ id: "kimi-k2.7-code", provider: "moonshot", api: "openai-responses" as const },
		{ id: "moonshotai/kimi-k2.7-code", provider: "openrouter", api: "openai-responses" as const },
		{ id: "moonshotai/kimi-k2.7-code-free", provider: "openrouter", api: "openai-responses" as const },
		{ id: "moonshotai/Kimi-K2.7-Code", provider: "baseten", api: "openai-responses" as const },
		{ id: "@cf/moonshotai/kimi-k2.7-code", provider: "workers-ai", api: "openai-responses" as const },
		{ id: "accounts/fireworks/models/kimi-k2p7-code", provider: "fireworks", api: "openai-responses" as const },
		{ id: "accounts/fireworks/routers/kimi-k2p7-code-fast", provider: "fireworks", api: "openai-responses" as const },
		{ id: "moonshotai/kimi-k2.7:thinking", provider: "openrouter", api: "openai-responses" as const },
	])("returns kimi-k2-7 preset for $provider/$id", ({ id, provider, api }) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(id, provider, api);

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("kimi-k2-7");
		expect(preset?.prompt).toContain("You are senpi");
		expect(preset?.prompt).toContain("running on Kimi K2.7");
		expect(preset?.prompt).toContain("## Intent Gate");
		expect(preset?.prompt.length).toBeGreaterThan(2_000);
	});

	it("keeps Kimi K2.6 on the kimi-k2-6 preset, distinct from K2.7", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const k26 = resolvePreset(createModel("kimi-k2.6-0528", "moonshot", "openai-responses"), settings);
		const k27 = resolvePreset(createModel("kimi-k2.7-0711", "moonshot", "openai-responses"), settings);

		// then
		expect(k26?.name).toBe("kimi-k2-6");
		expect(k26?.prompt).not.toContain("running on Kimi K2.7");
		expect(k27?.name).toBe("kimi-k2-7");
		expect(k27?.prompt).not.toContain("filler verification language");
	});

	it("allows settings.json to force kimi-k2-7 regardless of model id", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "kimi-k2-7" };
		const model = createModel("gpt-5.5", "openai-codex", "openai-codex-responses");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("kimi-k2-7");
		expect(preset?.prompt).toContain("running on Kimi K2.7");
	});

	it("returns kimi-k2-6 preset for every Kimi K2.6 built-in catalog model", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const catalogModels = getKimiK26CatalogModels();
		const catalogModelIds = catalogModels.map((model) => `${model.provider}/${model.id}`);

		// when
		const misses = catalogModels
			.filter((model) => resolvePresetName(model, settings) !== "kimi-k2-6")
			.map((model) => `${model.provider}/${model.id}`);

		// then
		expect(catalogModelIds).toEqual(
			expect.arrayContaining([
				"fireworks/accounts/fireworks/models/kimi-k2p6",
				"moonshotai/kimi-k2.6",
				"openrouter/moonshotai/kimi-k2.6",
			]),
		);
		expect(misses).toEqual([]);
	});

	it("returns kimi-k2-7 preset for every Kimi K2.7 built-in catalog model", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const catalogModels = getKimiK27CatalogModels();
		const catalogModelIds = catalogModels.map((model) => `${model.provider}/${model.id}`);

		// when
		const misses = catalogModels
			.filter((model) => resolvePresetName(model, settings) !== "kimi-k2-7")
			.map((model) => `${model.provider}/${model.id}`);

		// then
		expect(catalogModelIds).toEqual(
			expect.arrayContaining([
				"fireworks/accounts/fireworks/models/kimi-k2p7-code",
				"moonshotai/kimi-k2.7-code",
				"openrouter/moonshotai/kimi-k2.7-code",
			]),
		);
		expect(misses).toEqual([]);
	});

	it("keeps colon-tagged Kimi K2.6 thinking variants on the kimi-k2-6 preset", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel("moonshotai/kimi-k2.6:thinking", "openrouter", "openai-responses");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("kimi-k2-6");
		expect(preset?.prompt).toContain("filler verification language");
	});

	it("returns undefined for unknown model", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel("some-random-model", "some-provider", "openai-responses");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset).toBeUndefined();
	});

	it("fallback prompt contains all expected structural sections", () => {
		const activePrompt = fallbackPrompt();
		expect(activePrompt).toContain("You are senpi");
		expect(activePrompt).toContain("## Intent Gate");
		expect(activePrompt).toContain("## Parallel Tool Calls");
		expect(activePrompt).toContain("## Exploration");
		expect(activePrompt).toContain("## Verification");
		expect(activePrompt).toContain("## Available Tools");
		expect(activePrompt).toContain("Current working directory: /repo");
	});

	it("allows settings.json to force claude-opus-4-7 regardless of model id", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "claude-opus-4-7" };
		const model = createModel("gpt-5.5", "openai-codex", "openai-codex-responses");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("claude-opus-4-7");
		expect(preset?.prompt).toContain("full set rather than the first item");
	});

	it("allows settings.json to force gpt-5 regardless of model id", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "gpt-5" };
		const model = createModel("claude-opus-4-7", "anthropic", "anthropic-messages");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("gpt-5");
		expect(preset?.prompt).toContain("Retrieval budget");
	});

	it("allows settings.json to force kimi-k2-6 regardless of model id", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "kimi-k2-6" };
		const model = createModel("gpt-5.5", "openai-codex", "openai-codex-responses");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("kimi-k2-6");
		expect(preset?.prompt).toContain("filler verification language");
	});

	it("uses model-level promptPreset metadata when settings are auto", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = {
			...createModel("provider-specific-kimi-alias", "custom", "openai-responses"),
			promptPreset: "kimi-k2-6",
		};

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("kimi-k2-6");
		expect(preset?.prompt).toContain("filler verification language");
	});

	it("keeps settings.json promptPreset as a hard override over model-level metadata", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "claude-opus-4-7" };
		const model = {
			...createModel("provider-specific-kimi-alias", "custom", "openai-responses"),
			promptPreset: "kimi-k2-6",
		};

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("claude-opus-4-7");
		expect(preset?.prompt).toContain("full set rather than the first item");
	});

	it("does not include Kimi tuning in claude-opus-4-8 preset", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel("claude-opus-4-8", "anthropic", "anthropic-messages");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("claude-opus-4-8");
		expect(preset?.prompt).not.toContain("filler verification language");
		expect(preset?.prompt).not.toContain("outcome-first");
	});

	it("does not include Kimi tuning in claude-opus-4-7 preset", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel("claude-opus-4-7", "anthropic", "anthropic-messages");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("claude-opus-4-7");
		expect(preset?.prompt).not.toContain("filler verification language");
		expect(preset?.prompt).not.toContain("outcome-first");
	});

	it("does not include Kimi tuning in gpt-5 preset", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel("gpt-5.5", "openai-codex", "openai-codex-responses");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("gpt-5.5");
		expect(preset?.prompt).not.toContain("filler verification language");
		expect(preset?.prompt).not.toContain("full set rather than the first item");
	});

	it("allows settings.json to force gpt-5.4 regardless of model id", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "gpt-5.4" };
		const model = createModel("claude-opus-4-7", "anthropic", "anthropic-messages");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("gpt-5.4");
		expect(preset?.prompt).toContain("reasoning effort");
	});

	it("allows settings.json to force gpt-5.5 regardless of model id", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "gpt-5.5" };
		const model = createModel("claude-opus-4-7", "anthropic", "anthropic-messages");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("gpt-5.5");
		expect(preset?.prompt).toContain("Todo discipline");
		expect(preset?.prompt).toContain("Dig deeper");
	});

	it("allows settings.json to force gpt-5.6 regardless of model id", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "gpt-5.6" };
		const model = createModel("claude-opus-4-7", "anthropic", "anthropic-messages");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("gpt-5.6");
		expect(preset?.prompt).toContain("fewest useful tool loops");
	});

	it("resolves gpt-5.2 preset", () => {
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel("gpt-5.2", "openai", "openai-responses");
		const preset = resolvePreset(model, settings);
		expect(preset?.name).toBe("gpt-5.2");
		expect(preset?.prompt).toContain("explicit budgets");
	});

	it("resolves gpt-5.3-codex preset", () => {
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel("gpt-5.3-codex", "openai-codex", "openai-codex-responses");
		const preset = resolvePreset(model, settings);
		expect(preset?.name).toBe("gpt-5.3-codex");
		expect(preset?.prompt).toContain("Bias hard toward action");
	});

	it("resolves claude-opus-4-8 preset", () => {
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel("claude-opus-4-8", "anthropic", "anthropic-messages");
		const preset = resolvePreset(model, settings);
		expect(preset?.name).toBe("claude-opus-4-8");
		expect(preset?.prompt).toContain("tool calls over reasoning");
	});

	it("resolves claude-opus-4-5 preset", () => {
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel("claude-opus-4-5", "anthropic", "anthropic-messages");
		const preset = resolvePreset(model, settings);
		expect(preset?.name).toBe("claude-opus-4-5");
		expect(preset?.prompt).toContain("ordered steps");
	});

	// Codex-style File operations guard. Every GPT-5.x preset must teach the model to
	// route file edits through `apply_patch`, file reads through `read`, and never to
	// substitute inline python (or sed/awk/heredoc) through bash. This is the senpi
	// equivalent of codex's `core/gpt_5_2_prompt.md` Task execution + Shell commands
	// + apply_patch sections collapsed into a single tuning paragraph.
	it.each([
		{ presetName: "gpt-5" as const, modelId: "gpt-5", provider: "openai", api: "openai-responses" as const },
		{ presetName: "gpt-5.2" as const, modelId: "gpt-5.2", provider: "openai", api: "openai-responses" as const },
		{
			presetName: "gpt-5.3-codex" as const,
			modelId: "gpt-5.3-codex",
			provider: "openai-codex",
			api: "openai-codex-responses" as const,
		},
		{ presetName: "gpt-5.4" as const, modelId: "gpt-5.4", provider: "openai", api: "openai-responses" as const },
		{ presetName: "gpt-5.5" as const, modelId: "gpt-5.5", provider: "openai", api: "openai-responses" as const },
		{ presetName: "gpt-5.6" as const, modelId: "gpt-5.6-sol", provider: "openai", api: "openai-responses" as const },
	])("$presetName preset includes the codex-style File operations guard", ({ presetName, modelId, provider, api }) => {
		const settings: PromptPresetSettings = { promptPreset: presetName };
		const model = createModel(modelId, provider, api);

		const preset = resolvePreset(model, settings);

		if (!preset) {
			throw new Error(`expected ${presetName} preset to resolve`);
		}
		expect(preset.name).toBe(presetName);

		const prompt = preset.prompt;
		// Positive routing: apply_patch is the canonical edit verb.
		expect(prompt).toMatch(/apply_patch/);
		// Positive routing: read is the canonical inspect verb.
		expect(prompt).toMatch(/\bread\b/);
		// Negative guard: no inline python through bash for file mutation/inspection.
		expect(prompt.toLowerCase()).toMatch(/python/);
		// Negative guard: codex's "do not waste tokens re-reading after apply_patch".
		expect(prompt.toLowerCase()).toMatch(/re-?read|do not.*read/);
		// Positive routing: prefer the senpi `grep` tool over invoking grep/rg through bash.
		expect(prompt.toLowerCase()).toMatch(/\brg\b|ripgrep/);
	});
});
