import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { getBuiltinModels, getBuiltinProviders } from "../../../ai/src/providers/all.ts";
import { APP_NAME } from "../../src/config.ts";
import {
	AUTO_RESOLVED_PRESET_NAMES,
	type BuildDynamicSystemPromptOptions,
	buildDynamicSystemPrompt,
	buildPreset,
	type PromptSurface,
	resolvePreset,
} from "../../src/core/extensions/builtin/prompt-preset/public.ts";
import { BASELINE_OPTIONS, BASELINE_SURFACES, WORKSTATION_FACTS } from "./prompt-presets-baseline-fixtures.ts";
import baseline from "./prompt-presets-native-baseline.json" with { type: "json" };

// Fix only sensor inputs; the real workstation renderer stays inside the hashed output.
vi.mock("../../src/core/dynamic-prompt/workstation.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/core/dynamic-prompt/workstation.ts")>();
	return {
		...actual,
		buildWorkstationSection: (options: Parameters<typeof actual.buildWorkstationSection>[0]) =>
			actual.buildWorkstationSection({ ...options, facts: WORKSTATION_FACTS }),
	};
});

const expectedHashes = new Map(Object.entries(baseline.hashes));
function expectNativeBytes(preset: string, prompt: string, surface: PromptSurface, input: number): void {
	const key = `${preset}:${surface}:${input}`;
	expect(createHash("sha256").update(prompt).digest("hex"), key).toBe(expectedHashes.get(key));
}

const catalog = getBuiltinProviders().flatMap((provider) => getBuiltinModels(provider));
const options: BuildDynamicSystemPromptOptions = {
	cwd: "/fixture",
	selectedTools: ["read", "eval", "apply_patch", "todo", "ask_user_question"],
	toolSnippets: { read: "READ_SENTINEL", eval: "EVAL_SENTINEL" },
	promptGuidelines: ["GUIDELINE_SENTINEL"],
	contextFiles: [{ path: "/fixture/AGENTS.md", content: "CONTEXT_SENTINEL" }],
	skills: [],
};

describe("public prompt generation (#3104)", () => {
	it.each(BASELINE_SURFACES)("matches the committed Native baseline across the catalog on %s", (surface) => {
		expect(catalog.length).toBeGreaterThan(0);
		for (const [index, input] of BASELINE_OPTIONS.entries()) {
			for (const model of catalog) {
				const settings = { ...input, surface };
				const generated = resolvePreset(model, { promptPreset: "auto" }, settings);
				expectNativeBytes(
					generated?.name ?? "auto",
					generated?.prompt ?? buildDynamicSystemPrompt(settings),
					surface,
					index,
				);
			}
		}
	});

	it("matches every forced preset and fallback captured from immutable main", () => {
		const presets = ["auto", "gpt-5", ...AUTO_RESOLVED_PRESET_NAMES] as const;
		expect(baseline.sourceCommit).toBe("30ba483cb9ec790a32bbc31002ee9f5f015058b7");
		expect(expectedHashes.size).toBe(presets.length * BASELINE_SURFACES.length * BASELINE_OPTIONS.length);
		for (const promptPreset of presets) {
			for (const surface of BASELINE_SURFACES) {
				for (const [index, input] of BASELINE_OPTIONS.entries()) {
					const settings = { ...input, surface };
					const generated = resolvePreset({ provider: "synthetic", id: "unknown" }, { promptPreset }, settings);
					expect(generated?.name ?? "auto").toBe(promptPreset);
					expectNativeBytes(promptPreset, generated?.prompt ?? buildDynamicSystemPrompt(settings), surface, index);
					if (promptPreset !== "auto") {
						expectNativeBytes(promptPreset, buildPreset(promptPreset, settings).prompt, surface, index);
					}
				}
			}
		}
	});

	it("preserves explicit settings and metadata precedence", () => {
		// given
		const model = { provider: "openai", id: "gpt-5.4", promptPreset: "claude-opus-5-5" };
		// when
		const automatic = resolvePreset(model, { promptPreset: "auto" }, BASELINE_OPTIONS[0]);
		const forced = resolvePreset(model, { promptPreset: "gpt-5.2" }, BASELINE_OPTIONS[0]);
		// then
		expect(automatic?.name).toBe("claude-opus-5-5");
		expect(forced?.name).toBe("gpt-5.2");
		expectNativeBytes("claude-opus-5-5", automatic?.prompt ?? "", "terminal", 0);
		expectNativeBytes("gpt-5.2", forced?.prompt ?? "", "terminal", 0);
	});

	it("exposes the actual default builder for unknown models", () => {
		// given
		const model = { provider: "synthetic", id: "unknown-model" };
		// when
		const preset = resolvePreset(model, { promptPreset: "auto" }, options);
		// then
		expect(preset).toBeUndefined();
		expectNativeBytes("auto", buildDynamicSystemPrompt(BASELINE_OPTIONS[0]), "terminal", 0);
	});

	it.each(BASELINE_SURFACES)("isolates host identity without native-name leaks on %s", (surface) => {
		// given
		const hostA = "OmO";
		const hostB = "HOST_B_SENTINEL";
		for (const model of catalog) {
			const render = (input: BuildDynamicSystemPromptOptions) =>
				resolvePreset(model, { promptPreset: "auto" }, input)?.prompt ?? buildDynamicSystemPrompt(input);
			const input = { ...options, surface };
			const native = render(input);
			// when
			const a = render({ ...input, appName: hostA });
			const b = render({ ...input, appName: hostB });
			// then
			expect(a.split("\n")[0]).toContain(hostA);
			expect(b.split("\n")[0]).toContain(hostB);
			expect(a, `${model.provider}/${model.id}`).not.toMatch(/\bsenpi\b/i);
			expect(b, `${model.provider}/${model.id}`).not.toMatch(/\bsenpi\b/i);
			expect(a.replaceAll(hostA, APP_NAME)).toBe(native);
			expect(b.replaceAll(hostB, APP_NAME)).toBe(native);
			expect(render(input)).toBe(native);
		}
	});

	it("does not rewrite a native brand mentioned in caller context", () => {
		const input = {
			...options,
			appName: "OmO",
			contextFiles: [{ path: "/fixture/AGENTS.md", content: `${APP_NAME} CONTEXT_SENTINEL` }],
		};
		const prompt = resolvePreset({ provider: "synthetic", id: "grok-4.5" }, { promptPreset: "auto" }, input)?.prompt;
		expect(prompt).toBeDefined();
		expect(prompt).toContain(`${APP_NAME} CONTEXT_SENTINEL`);
		expect(prompt).not.toContain("OmO CONTEXT_SENTINEL");
	});
});
