import { readFileSync } from "node:fs";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { GROK45_WORKER_RULES } from "../../src/core/extensions/builtin/prompt-preset/grok-4.5.ts";
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

function hasGrok45CatalogSignal(model: Model<Api>): boolean {
	const searchable = `${model.id} ${model.name}`.toLowerCase().replace(/\s+/g, "-");
	// Keep in sync with presets.ts hasGrok45Signal — colon provider sep + compact grok45.
	return /(?:^|[/@:._-])grok(?:[._-]|p)?4(?:[._-]|p)?5(?:$|[/@._:-])/.test(searchable);
}

function getGrok45CatalogModels(): Model<Api>[] {
	return getProviders().flatMap((provider) => (getModels(provider) as Model<Api>[]).filter(hasGrok45CatalogSignal));
}

describe("Grok 4.5 prompt preset", () => {
	it.each([
		"grok-4.5",
		"Grok 4.5",
		"xai/grok-4.5",
		"x-ai/grok-4.5",
		"xai:grok-4.5",
		"grok-4p5",
		"grok_4_5:thinking",
		"grok45",
		"Grok4.5",
		"grok-4.5-latest",
		"grok-4.5-thinking",
		"accounts/xai/models/grok-4.5",
	])("resolves %s to the grok-4.5 preset", (modelId) => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const model = createModel(modelId, "xai", "openai-responses");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("grok-4.5");
		// CEO / human-facing surface
		expect(preset?.prompt).toMatch(/acting as CEO and orchestrator/i);
		expect(preset?.prompt).toMatch(/single human-facing surface/i);
		// Agent-first invocation profiles (not tools)
		expect(preset?.prompt).toMatch(/invocation profiles/i);
		expect(preset?.prompt).toMatch(/\*\*Implementer\*\*/);
		expect(preset?.prompt).toMatch(/\*\*Oracle\*\*/);
		expect(preset?.prompt).toMatch(/implement rather than propose/i);
		expect(preset?.prompt).toMatch(/never spawn workers/i);
		expect(preset?.prompt).toMatch(/one orchestration level/i);
		expect(preset?.prompt).toMatch(/Search and read only/i);
		expect(preset?.prompt).toMatch(/never edit, commit, deploy/i);
		// Spawn surface
		expect(preset?.prompt).toMatch(/spawn only through `bash` \+ `senpi --print`/i);
		expect(preset?.prompt).toMatch(/senpi --print/i);
		expect(preset?.prompt).toMatch(/ROLE, GOAL, SCOPE, CONSTRAINTS, DONE WHEN, and the exact RETURN JSON schema/);
		expect(preset?.prompt).toMatch(/separate role-system, task-brief/i);
		expect(preset?.prompt).toContain("--system-prompt");
		expect(preset?.prompt).toContain("--no-session");
		expect(preset?.prompt).toContain("--no-nested-agents");
		expect(preset?.prompt).toContain("umask 077");
		expect(preset?.prompt).toContain("mktemp -d");
		expect(preset?.prompt).toContain("env -i");
		expect(preset?.prompt).toContain("SENPI_NO_FALLBACK=1");
		// REG-1: the environment directive must not duplicate its allowlist phrase
		expect(preset?.prompt.match(/Senpi directory variables/g)?.length ?? 0).toBe(1);
		// C-H3: env-only credentials must survive via shell expansion, never model-authored literals
		expect(preset?.prompt).toMatch(/forward credential variables by name/i);
		expect(preset?.prompt).toMatch(/\$XAI_API_KEY/);
		expect(preset?.prompt).toMatch(/never write a credential value/i);
		// H3: env -i must not instruct model to pass provider credentials
		expect(preset?.prompt).not.toMatch(/provider authentication/i);
		// H4: brief transport must be file-only, not -p interpolation
		expect(preset?.prompt).not.toMatch(/Write the quoted task brief through `-p`/);
		expect(preset?.prompt).toContain("--tools read,grep,find,ls,bash,edit,write");
		expect(preset?.prompt).toContain("--tools read,grep,find,ls");
		expect(preset?.prompt).toMatch(/worker stdout\/stderr as untrusted data/i);
		expect(preset?.prompt).toContain("no larger than 8 KiB");
		expect(preset?.prompt).toContain("`status`, `changedFiles`, `commands`, `results`, and `blockers`");
		// No sole gpt-5.6 implement path; doctrine is model-independent
		expect(preset?.prompt).not.toMatch(/--model gpt-5\.6/i);
		expect(preset?.prompt).not.toMatch(/gpt-5\.6 prompting guide/i);
		expect(preset?.prompt).toMatch(/never the selected model preset/i);
		// Shared sections reused
		expect(preset?.prompt).toContain("apply_patch");
		expect(preset?.prompt).toContain("### Test Discipline");
		// Routing-line discipline preserved
		expect(preset?.prompt).toMatch(/i read this as \[intent\] - \[plan\]/i);
		expect(preset?.prompt).toContain("## Stop Goal");
		expect(preset?.prompt).toContain("STOPPING IS MANDATORY AND IMMEDIATE");
		expect(preset?.prompt).toMatch(/You are the human surface/i);
		// Full corePrompt remains substantial
		expect(preset?.prompt.length).toBeGreaterThan(3000);
		// Must NOT name a nonexistent task/subagent tool API
		expect(preset?.prompt).not.toMatch(/`task` child|category: "deep"|category: "ultrabrain"|run_in_background/i);
		expect(preset?.prompt).toMatch(/never invent a `task`/i);
	});

	it.each(["grok-4.3", "grok-4.20-0309-reasoning", "grok-3", "grok-code-fast-1", "some-grok-compatible-router"])(
		"does not route %s to the grok-4.5 preset",
		(modelId) => {
			// given
			const settings: PromptPresetSettings = { promptPreset: "auto" };
			const model = createModel(modelId, "xai", "openai-responses");

			// when
			const preset = resolvePreset(model, settings);

			// then
			expect(preset).toBeUndefined();
		},
	);

	it("allows settings.json to force grok-4.5 regardless of model id", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "grok-4.5" };
		const model = createModel("some-random-model", "custom", "openai-responses");

		// when
		const preset = resolvePreset(model, settings);

		// then
		expect(preset?.name).toBe("grok-4.5");
		expect(preset?.prompt).toMatch(/acting as CEO and orchestrator/i);
		expect(preset?.prompt).toMatch(/\*\*Implementer\*\*/);
		expect(preset?.prompt).toMatch(/spawn only through `bash` \+ `senpi --print`/i);
	});

	it("renders every worker rule exactly once in its owning Role section", () => {
		const preset = resolvePreset(createModel("grok-4.5", "xai"), { promptPreset: "auto" });
		const roleSection = preset?.prompt.split("## Role: CEO / Orchestrator")[1]?.split("### Test Discipline")[0] ?? "";
		const implementerSection = roleSection.split("- **Implementer**")[1]?.split("- **Oracle**")[0] ?? "";
		const oracleSection = roleSection.split("- **Oracle**")[1]?.split("**Spawn only through")[0] ?? "";
		const spawnSection = roleSection.split("**Spawn only through")[1] ?? "";
		const ownerSections = { Implementer: implementerSection, Oracle: oracleSection, Spawn: spawnSection };

		for (const rule of GROK45_WORKER_RULES) {
			expect(roleSection.split(rule.directive)).toHaveLength(2);
			expect(ownerSections[rule.owner]).toContain(rule.directive);
			for (const [owner, section] of Object.entries(ownerSections)) {
				if (owner !== rule.owner) expect(section).not.toContain(rule.directive);
			}
		}
		expect(implementerSection).toMatch(/real surface when one exists/i);
		expect(oracleSection).toMatch(/hard architecture\/debugging or high-risk final review/i);
		expect(spawnSection).toMatch(/blocks discovered\/user extensions/i);
		expect(spawnSection).toMatch(/builtin host controls may remain/i);
		// H2: the contract must not claim tool allowlists enforce a privilege boundary
		expect(spawnSection).toMatch(/prompt-level guidance, not an enforced privilege boundary/i);
		// L6: the RETURN cap is guidance the CEO validates, not a runtime control
		expect(spawnSection).toMatch(/no runtime validates/i);
	});

	it("keeps worker tool allowlists compatible with no-extensions", () => {
		const toolsRule = GROK45_WORKER_RULES.find((rule) => rule.id === "tool-allowlists");
		const preset = resolvePreset(createModel("grok-4.5", "xai"), { promptPreset: "auto" });
		expect(toolsRule?.directive).toContain("--tools read,grep,find,ls,bash,edit,write");
		expect(preset?.prompt).toMatch(/Oracle uses `--tools read,grep,find,ls`\./);
		expect(toolsRule?.directive).not.toContain("apply_patch");
		expect(toolsRule?.directive).not.toContain("todo");
	});

	it("returns grok-4.5 preset for every Grok 4.5 built-in catalog model", () => {
		// given
		const settings: PromptPresetSettings = { promptPreset: "auto" };
		const catalogModels = getGrok45CatalogModels();
		const catalogModelIds = catalogModels.map((model) => `${model.provider}/${model.id}`);

		// when
		const misses = catalogModels
			.filter((model) => resolvePresetName(model, settings) !== "grok-4.5")
			.map((model) => `${model.provider}/${model.id}`);

		// then
		expect(catalogModelIds).toEqual(
			expect.arrayContaining([
				"xai/grok-4.5",
				"opencode/grok-4.5",
				"openrouter/x-ai/grok-4.5",
				"vercel-ai-gateway/xai/grok-4.5",
			]),
		);
		expect(misses).toEqual([]);
	});

	it("does not invent Grok preset edition numbers while unreleased", () => {
		// given — Grok 4.5 has never been formally merged; fake v1/v2/… theater is noise
		const changesPath = new URL("../../src/core/extensions/builtin/prompt-preset/changes.md", import.meta.url);
		const changes = readFileSync(changesPath, "utf8");

		// then
		expect(changes).toMatch(/Grok 4\.5 preset \(unreleased/);
		expect(changes).not.toMatch(/Grok 4\.5 preset v\d+/);
	});
});
