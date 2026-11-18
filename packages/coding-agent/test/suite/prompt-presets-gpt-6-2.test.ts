import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import type { PromptSurface } from "../../src/core/dynamic-prompt/build.ts";
import { GPT6_ASTRA_RULES } from "../../src/core/extensions/builtin/prompt-preset/gpt-6-astra.ts";
import {
	GPT62_RULES,
	GPT62_SECTIONS,
	type Gpt62Rule,
} from "../../src/core/extensions/builtin/prompt-preset/gpt-6.2.ts";
import { hasGpt62Signal } from "../../src/core/extensions/builtin/prompt-preset/matchers.ts";
import { type PromptPresetSettings, resolvePreset } from "../../src/core/extensions/builtin/prompt-preset/presets.ts";

function createModel(id: string, provider = "openai", api: Api = "openai-responses"): Model<Api> {
	return {
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.com/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400_000,
		maxTokens: 128_000,
	};
}

const AUTO: PromptPresetSettings = { promptPreset: "auto" };
const SURFACES: readonly PromptSurface[] = ["terminal", "app", "chat"];
const RULES: readonly Gpt62Rule[] = GPT62_RULES;
const TOOL_BOUND = RULES.filter((rule) => rule.requiresTool !== undefined);
const SESSION_TOOLS = [
	"read",
	"apply_patch",
	"todo",
	"request_user_input",
	...TOOL_BOUND.flatMap((rule) => rule.requiresTool ?? []),
];

function render(presetName: "gpt-6.2" | "gpt-6-astra", selectedTools: readonly string[], surface: PromptSurface) {
	const preset = resolvePreset(
		createModel(presetName),
		{ promptPreset: presetName },
		{
			cwd: "/repo",
			selectedTools: [...selectedTools],
			toolSnippets: { read: "READ_SNIPPET" },
			promptGuidelines: ["GUIDELINE_SENTINEL"],
			contextFiles: [],
			skills: [],
			surface,
		},
	);
	if (!preset) throw new Error(`expected ${presetName} to resolve`);
	return preset.prompt;
}

function sectionsOf(prompt: string): Map<string, string> {
	const sections = new Map<string, string>();
	for (const part of prompt.split(/^## /m).slice(1)) {
		const breakIndex = part.indexOf("\n");
		sections.set(part.slice(0, breakIndex).trim(), part.slice(breakIndex + 1));
	}
	return sections;
}

function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

// senpi#6942: GPT-6.2 Astra and Sol share one guide and one codex template, so both resolve to the
// gpt-6.2 preset ahead of the GPT-6 family signal, and the older family keeps gpt-6-astra.
describe("GPT-6.2 prompt preset", () => {
	it.each([
		{ id: "gpt-6.2-astra", provider: "openai", api: "openai-responses" as const },
		{ id: "gpt-6.2-sol", provider: "openai", api: "openai-responses" as const },
		{ id: "gpt-6.2-astra-fast", provider: "chatgpt-subscription", api: "openai-codex-responses" as const },
		{ id: "gpt-6.2-sol-ultrafast", provider: "chatgpt-subscription", api: "openai-codex-responses" as const },
		{ id: "openai/gpt-6.2-astra", provider: "openrouter", api: "openai-completions" as const },
		{ id: "openai/gpt-6.2-sol-fast", provider: "vercel-ai-gateway", api: "anthropic-messages" as const },
		{ id: "openai-gpt-62-sol", provider: "venice", api: "openai-completions" as const },
		{ id: "GPT-6.2-Astra", provider: "custom", api: "openai-responses" as const },
	])("resolves $provider/$id to gpt-6.2", ({ id, provider, api }) => {
		expect(resolvePreset(createModel(id, provider, api), AUTO)?.name).toBe("gpt-6.2");
	});

	it.each(["GPT-6.2 Astra", "GPT-6.2 Sol"])("resolves the display name %s when the id carries no family", (name) => {
		const model: Model<Api> = { ...createModel("default-model", "custom"), name };
		expect(resolvePreset(model, AUTO)?.name).toBe("gpt-6.2");
	});

	it.each(["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna-fast", "openai-gpt-61-sol", "gpt-6.12-sol"])(
		"keeps %s on gpt-6-astra",
		(id) => {
			expect(resolvePreset(createModel(id), AUTO)?.name).toBe("gpt-6-astra");
		},
	);

	it("renders one prompt for Astra and Sol", () => {
		const astra = resolvePreset(createModel("gpt-6.2-astra"), AUTO)?.prompt;
		const sol = resolvePreset(createModel("gpt-6.2-sol"), AUTO)?.prompt;
		expect(astra).toBeDefined();
		expect(sol).toBe(astra);
	});

	it("is selectable by name in settings for any model", () => {
		expect(resolvePreset(createModel("gpt-6-astra"), { promptPreset: "gpt-6.2" })?.name).toBe("gpt-6.2");
	});

	it("routes every GPT-6.2 catalog row to gpt-6.2", () => {
		const rows = getProviders().flatMap((provider) =>
			getModels(provider).filter((model) => hasGpt62Signal(model.id) || hasGpt62Signal(model.name)),
		);
		expect(rows.map((model) => model.id)).toEqual(expect.arrayContaining(["gpt-6.2-astra", "gpt-6.2-sol"]));
		for (const model of rows) {
			expect(resolvePreset(model, AUTO)?.name, `${model.provider}/${model.id}`).toBe("gpt-6.2");
		}
	});
});

// senpi#6979: the core is rule data rendered once per rule under the section that owns it.
describe("GPT-6.2 core", () => {
	it.each(SURFACES)("renders each rule of the %s surface once, under its own section", (surface) => {
		const prompt = render("gpt-6.2", SESSION_TOOLS, surface);
		const sections = sectionsOf(prompt);

		for (const rule of RULES) {
			const expected = rule.surfaces === undefined || rule.surfaces.includes(surface) ? 1 : 0;
			expect(occurrences(prompt, rule.directive), rule.id).toBe(expected);
			expect(occurrences(sections.get(rule.section) ?? "", rule.directive), `${rule.id} in ${rule.section}`).toBe(
				expected,
			);
		}
		expect([...sections.keys()]).toEqual([...GPT62_SECTIONS, "Tool Guidelines"]);
	});

	it("renders a tool-bound rule for any one of its tools and drops it without them", () => {
		expect(TOOL_BOUND.length).toBeGreaterThan(0);
		const unbound = render("gpt-6.2", ["read", "apply_patch"], "terminal");

		for (const rule of TOOL_BOUND) {
			expect(occurrences(unbound, rule.directive), `${rule.id} without its tools`).toBe(0);
			for (const tool of rule.requiresTool ?? []) {
				expect(
					occurrences(render("gpt-6.2", ["read", tool], "terminal"), rule.directive),
					`${rule.id} with ${tool}`,
				).toBe(1);
			}
		}
	});

	it("keeps the guidelines and renders no tool list", () => {
		const sections = sectionsOf(render("gpt-6.2", SESSION_TOOLS, "terminal"));

		expect(sections.get("Tool Guidelines")).toContain("GUIDELINE_SENTINEL");
		expect(sections.has("Available Tools")).toBe(false);
		expect([...sections.values()].join("\n")).not.toContain("READ_SNIPPET");
	});

	it("shares no rule text with the gpt-6-astra core", () => {
		const gpt62 = render("gpt-6.2", SESSION_TOOLS, "terminal");
		const astra = render("gpt-6-astra", SESSION_TOOLS, "terminal");

		for (const rule of GPT6_ASTRA_RULES) expect(gpt62, `astra rule ${rule.id}`).not.toContain(rule.directive);
		for (const rule of RULES) expect(astra, `gpt-6.2 rule ${rule.id}`).not.toContain(rule.directive);
	});

	// The emphasis budget of this core: no bold, no capitalized emphasis, and "Never" only for the
	// invariants (the limits and the refusal rule).
	it("spends no emphasis outside the limits and the refusal rule", () => {
		for (const rule of RULES) {
			expect(rule.directive, rule.id).not.toMatch(/\*\*|\b[A-Z]{3,}\b|\p{Extended_Pictographic}/u);
			const invariant = rule.section === "Limits" || rule.id === "refusal-is-final";
			expect(/\bNever\b/.test(rule.directive), rule.id).toBe(invariant);
		}
	});
});
