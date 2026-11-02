import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { buildDynamicSystemPrompt, type PromptSurface } from "../../src/core/dynamic-prompt/build.ts";
import { buildWorkstationSection } from "../../src/core/dynamic-prompt/workstation.ts";
import {
	type PromptPresetSettings,
	resolvePreset,
	resolvePresetName,
} from "../../src/core/extensions/builtin/prompt-preset/presets.ts";
import { BASELINE_OPTIONS, BASELINE_SURFACES, WORKSTATION_FACTS } from "./prompt-presets-baseline-fixtures.ts";
import baseline from "./prompt-presets-native-baseline.json" with { type: "json" };

vi.mock("../../src/core/dynamic-prompt/workstation.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/core/dynamic-prompt/workstation.ts")>();
	return {
		...actual,
		buildWorkstationSection: (options: Parameters<typeof actual.buildWorkstationSection>[0]) =>
			actual.buildWorkstationSection({ ...options, facts: WORKSTATION_FACTS }),
	};
});

const AUTO: PromptPresetSettings = { promptPreset: "auto" };

function createModel(id: string, provider: string, api: Api = "google-generative-ai", name = id): Model<Api> {
	return {
		id,
		name,
		api,
		provider,
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	};
}

function hasArgonCatalogSignal(model: Model<Api>): boolean {
	return `${model.id} ${model.name}`.toLowerCase().replace(/\s+/g, "-").includes("gemini-4-argon");
}

function getArgonCatalogModels(): Model<Api>[] {
	return getProviders().flatMap((provider) => getModels(provider).filter(hasArgonCatalogSignal));
}

/** Top-level `## ` sections (and the trailing workstation block) keyed by heading, so untouched sections compare whole. */
function sections(prompt: string): Map<string, string> {
	const out = new Map<string, string>();
	let heading = "(preamble)";
	let body: string[] = [];
	for (const line of prompt.split("\n")) {
		if (line.startsWith("## ") || line === "<workstation>") {
			out.set(heading, body.join("\n"));
			heading = line;
			body = [];
			continue;
		}
		body.push(line);
	}
	out.set(heading, body.join("\n"));
	return out;
}

const TOOLS_WITH_EVAL = ["read", "edit", "eval", "todo", "web_search"];
const TOOLS_WITHOUT_EVAL = ["read", "edit", "todo"];

function render(surface: PromptSurface, selectedTools: string[]): { argon: string; base: string } {
	const input = { ...BASELINE_OPTIONS[1], selectedTools, surface };
	const argon = resolvePreset(createModel("gemini-4-argon", "google"), AUTO, input)?.prompt ?? "";
	return { argon, base: buildDynamicSystemPrompt(input) };
}

describe("Argon prompt preset (#3385)", () => {
	it.each([
		"gemini-4-argon",
		"google/gemini-4-argon",
		"google/gemini-4-argon:batch",
		"gemini-4-argon-contributor",
		"gemini-4-argon-low",
		"gemini-4-argon-high",
		"google-vertex/gemini-4-argon",
		"Gemini 4 Argon",
	])("resolves %s to the gemini-4-argon preset", (modelId) => {
		expect(resolvePresetName(createModel(modelId, "google"), AUTO)).toBe("gemini-4-argon");
	});

	it.each(["gemini-4", "gemini-3.8-flash", "gemini-3.1-pro", "gemini-4-flash", "gemini-4-argonite", "argon"])(
		"leaves %s on the default dynamic prompt",
		(modelId) => {
			expect(resolvePresetName(createModel(modelId, "google"), AUTO)).toBeUndefined();
		},
	);

	it("returns the preset for every Argon built-in catalog model", () => {
		const catalogModels = getArgonCatalogModels();
		expect(catalogModels.length).toBeGreaterThan(0);
		const misses = catalogModels
			.filter((model) => resolvePresetName(model, AUTO) !== "gemini-4-argon")
			.map((model) => `${model.provider}/${model.id}`);
		expect(misses).toEqual([]);
	});

	it("allows settings.json to force gemini-4-argon regardless of model id", () => {
		const preset = resolvePreset(createModel("some-random-model", "custom", "openai-responses"), {
			promptPreset: "gemini-4-argon",
		});
		expect(preset?.name).toBe("gemini-4-argon");
	});

	it.each(BASELINE_SURFACES)("differs from the default core only in the tuned spots on %s", (surface) => {
		const { argon, base } = render(surface, TOOLS_WITH_EVAL);
		const argonSections = sections(argon);
		const baseSections = sections(base);

		const changed = [...baseSections.keys()].filter((key) => argonSections.get(key) !== baseSections.get(key));
		const added = [...argonSections.keys()].filter((key) => !baseSections.has(key));
		const expectedChanged = ["(preamble)", "## Working the Task", "## Policies", "<workstation>"];
		if (surface === "terminal") expectedChanged.push("## Intent Gate");
		expect(changed.sort()).toEqual(expectedChanged.sort());
		expect(added).toEqual(["## Search Grounding"]);
		expect(baseSections.get("<workstation>")).toContain("**EXECUTION HAPPENS HERE.**");

		expect(argon.split("\n")[0]).toContain("running on Gemini 4 Argon");
		expect(argonSections.get("## Working the Task")).toContain("Writing code is your superpower");
		expect(argonSections.get("## Working the Task")).toContain("parallel(thunks)");
		expect(argonSections.get("## Policies")).toContain("transient failure");
		expect(argonSections.get("## Policies")).not.toContain("blind retries");
		expect(argon).not.toContain("**EXECUTION HAPPENS HERE.**");
		expect(argon).not.toContain("## File operations");
		if (surface === "terminal") {
			expect(argonSections.get("## Intent Gate")).toContain("The line is plain prose");
		} else {
			expect(argonSections.get("## Intent Gate")).toBe(baseSections.get("## Intent Gate"));
		}
	});

	it("keeps the default Working the Task opening and no grounding section without eval and web_search", () => {
		const { argon, base } = render("terminal", TOOLS_WITHOUT_EVAL);
		expect(sections(argon).get("## Working the Task")).toBe(sections(base).get("## Working the Task"));
		expect(argon).not.toContain("## Search Grounding");
		expect(argon).not.toContain("superpower");
	});

	it("renders the gemini workstation dialect without tags or shouting", () => {
		const section = buildWorkstationSection({
			selectedTools: ["bash", "eval"],
			dialect: "gemini",
			facts: WORKSTATION_FACTS,
		});
		const instruction = section.slice(section.indexOf("</workstation>"));
		expect(instruction).toContain("`bash` and `eval` execute on this workstation");
		expect(instruction).not.toContain("<execution_context>");
		expect(instruction).not.toMatch(/\b[A-Z]{4,}\b/);
	});

	it("is pinned in the native baseline without touching any other preset's hash", () => {
		const keys = Object.keys(baseline.hashes);
		const argonKeys = keys.filter((key) => key.startsWith("gemini-4-argon:"));
		expect(argonKeys.sort()).toEqual(
			BASELINE_SURFACES.flatMap((surface) =>
				BASELINE_OPTIONS.map((_, index) => `gemini-4-argon:${surface}:${index}`),
			).sort(),
		);
	});
});
