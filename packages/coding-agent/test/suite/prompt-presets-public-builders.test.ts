import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { APP_NAME } from "../../src/config.ts";
import { buildClaudeFable51Prompt } from "../../src/core/extensions/builtin/prompt-preset/claude-fable-5-1.ts";
import { buildClaudeOpus55Prompt } from "../../src/core/extensions/builtin/prompt-preset/claude-opus-5-5.ts";
import { buildGpt54Prompt } from "../../src/core/extensions/builtin/prompt-preset/gpt-5.4.ts";
import promptPresetExtension from "../../src/core/extensions/builtin/prompt-preset/index.ts";
import { resolvePreset as runtimeResolvePreset } from "../../src/core/extensions/builtin/prompt-preset/presets.ts";
import {
	AUTO_RESOLVED_PRESET_NAMES,
	type BuildDynamicSystemPromptOptions,
	buildDynamicSystemPrompt,
	buildPreset,
	PROMPT_PRESET_MODEL_CASES,
	resolvePreset,
	resolvePresetName,
} from "../../src/core/extensions/builtin/prompt-preset/public.ts";
import { createHarness, type Harness } from "./harness.ts";

const options: BuildDynamicSystemPromptOptions = {
	cwd: "/synthetic-project",
	selectedTools: ["read", "bash", "ask_user_question"],
	toolSnippets: { read: "READ_CAPABILITY_SENTINEL" },
	promptGuidelines: ["GUIDELINE_SENTINEL"],
	contextFiles: [{ path: "/synthetic-project/AGENTS.md", content: "CONTEXT_SENTINEL" }],
	skills: [],
	surface: "terminal",
};

const modelBuilders = [
	{ id: "claude-opus-5-5", build: buildClaudeOpus55Prompt },
	{ id: "claude-fable-5-1", build: buildClaudeFable51Prompt },
	{ id: "gpt-5.4", build: buildGpt54Prompt },
];

describe("public Native prompt generation", () => {
	it("exports the runtime resolver itself, not a second implementation", () => {
		expect(resolvePreset).toBe(runtimeResolvePreset);
	});

	it("preserves the name contract and renders every advertised preset", () => {
		const rendered = new Set<string>();
		for (const entry of PROMPT_PRESET_MODEL_CASES) {
			const model = { provider: entry.providerID, id: entry.modelID };
			const name = resolvePresetName(entry);
			expect(name).toBe(entry.preset);
			if (!name) throw new Error(`Missing preset: ${entry.modelID}`);
			const actual = resolvePreset(model, { promptPreset: "auto" }, options);
			expect(actual?.name).toBe(name);
			expect(buildPreset(name, options).name).toBe(name);
			expect(buildPreset(name, { ...options, appName: "HOST_NAME_SENTINEL" }).prompt).toContain(
				"HOST_NAME_SENTINEL",
			);
			rendered.add(name);
		}
		expect([...rendered].sort()).toEqual([...AUTO_RESOLVED_PRESET_NAMES].sort());
	});

	it.each(modelBuilders)("renders $id's actual body rather than another variant's label", ({ id, build }) => {
		const actual = resolvePreset({ provider: "synthetic", id }, { promptPreset: "auto" }, options);
		expect(actual?.prompt).toBe(build(options));
	});

	it("keeps explicit settings and model preset metadata ahead of automatic selection", () => {
		const model = { provider: "synthetic", id: "claude-opus-5-5", promptPreset: "gpt-5.4" };
		expect(resolvePreset(model, { promptPreset: "auto" }, options)).toEqual(buildPreset("gpt-5.4", options));
		expect(resolvePreset(model, { promptPreset: "gpt-5" }, options)).toEqual(buildPreset("gpt-5", options));
	});

	it.each(modelBuilders)("preserves default branding and accepts an explicit host name for $id", ({ id }) => {
		const model = { provider: "synthetic", id };
		const defaultPrompt = resolvePreset(model, { promptPreset: "auto" }, options);
		expect(resolvePreset(model, { promptPreset: "auto" }, { ...options, appName: APP_NAME })).toEqual(defaultPrompt);
		expect(
			resolvePreset(model, { promptPreset: "auto" }, { ...options, appName: "HOST_NAME_SENTINEL" })?.prompt,
		).toContain("HOST_NAME_SENTINEL");
	});

	it("exposes Native fallback generation without inventing a preset for an unknown model", () => {
		expect(
			resolvePreset({ provider: "synthetic", id: "unknown" }, { promptPreset: "auto" }, options),
		).toBeUndefined();
		expect(buildDynamicSystemPrompt(options)).toBe(buildDynamicSystemPrompt({ ...options, appName: APP_NAME }));
		expect(buildDynamicSystemPrompt({ ...options, appName: "HOST_NAME_SENTINEL" })).toContain("HOST_NAME_SENTINEL");
	});
});

describe("public output matches real Native session callbacks", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	it.each(modelBuilders)("matches the actual session prompt for $id", async ({ id }) => {
		let nativeOptions: Partial<BuildDynamicSystemPromptOptions> | undefined;
		const harness = await createHarness({
			models: [{ id, name: id, reasoning: true }],
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						nativeOptions = event.systemPromptOptions;
					});
				},
				promptPresetExtension,
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt("Return the synthetic response.");

		expect(nativeOptions).toBeDefined();
		const shared = resolvePreset(harness.getModel(), { promptPreset: "auto" }, nativeOptions);
		expect(shared).toBeDefined();
		expect(harness.session.systemPrompt).toBe(shared?.prompt);
	});
});
