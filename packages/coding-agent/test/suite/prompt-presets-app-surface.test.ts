import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type BuildDynamicSystemPromptOptions,
	buildDynamicSystemPrompt,
	type PromptSurface,
	resolvePromptSurface,
} from "../../src/core/dynamic-prompt/build.ts";
import promptPresetExtension from "../../src/core/extensions/builtin/prompt-preset/index.ts";
import { resolvePreset } from "../../src/core/extensions/builtin/prompt-preset/presets.ts";
import { type PromptPresetName, VALID_PRESETS } from "../../src/core/extensions/builtin/prompt-preset/settings.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness, type Harness } from "./harness.ts";

// The app surface (SENPI_PROMPT_SURFACE=app) is the contract a host that renders
// replies in a chat UI relies on: no routing-line mandate, and tool/hook feedback
// stays with the agent. The chat surface (a chat bridge, senpi#2398) keeps every app
// rule and also drops the handoff block. The terminal surface keeps the routing line.
const ROUTING_LINE_SENTINEL = "I read this as";
const FEEDBACK_GUIDANCE = /tool and hook feedback/i;
const COVERED_BY_EVIDENCE = "covered by the evidence that did run";
const HANDOFF_TEMPLATE = [/Ask: \[/, /For you:/, /Now: \[/, /handoff block/i];
const HANDOFF_SLOT = /For you|You need/;
const UNRUN_CHECK_REPORTING =
	/flag the unverified explicitly|could not (verify|run)|cannot run, say so|what you could not and why/i;

function occurrences(text: string, needle: RegExp): number {
	return text.match(new RegExp(needle.source, "gi"))?.length ?? 0;
}

function intentGate(text: string): string {
	const start = text.indexOf("## Intent Gate");
	return text.slice(start, text.indexOf("\n## ", start + 1));
}

const PRESET_NAMES = [...VALID_PRESETS].filter((name): name is Exclude<PromptPresetName, "auto"> => name !== "auto");
const PROMPTS = ["dynamic", ...PRESET_NAMES] as const;
const NON_TERMINAL_SURFACES = ["app", "chat"] as const;
const NON_TERMINAL_CASES = PROMPTS.flatMap((prompt) =>
	NON_TERMINAL_SURFACES.map((surface) => [prompt, surface] as const),
);

const OPTIONS: BuildDynamicSystemPromptOptions = {
	cwd: "/repo",
	selectedTools: ["read", "bash", "edit", "write", "grep", "eval", "todo", "monitor", "task", "ask_user_question"],
	toolSnippets: { eval: "Run one persistent code cell." },
	promptGuidelines: [],
	contextFiles: [],
	skills: [],
};

function render(prompt: (typeof PROMPTS)[number], surface?: PromptSurface): string {
	const options = surface ? { ...OPTIONS, surface } : OPTIONS;
	if (prompt === "dynamic") return buildDynamicSystemPrompt(options);
	const preset = resolvePreset({ id: "unmatched-model", provider: "test" }, { promptPreset: prompt }, options);
	if (!preset) throw new Error(`preset ${prompt} did not render`);
	return preset.prompt;
}

describe("prompt surface contract", () => {
	it("covers every preset name settings.json accepts", () => {
		expect(PRESET_NAMES.length).toBeGreaterThan(20);
	});

	it.each(NON_TERMINAL_CASES)(
		"%s on the %s surface drops the routing line and keeps tool feedback with the agent",
		(prompt, surface) => {
			const text = render(prompt, surface);

			expect(text).not.toContain(ROUTING_LINE_SENTINEL);
			expect(text).not.toMatch(/routing line/i);
			expect(text).not.toMatch(/declared stop condition/i);
			expect(text).toContain("## Intent Gate");
		},
	);

	it.each(NON_TERMINAL_CASES)(
		"%s on the %s surface covers an unrun check with the evidence that did run",
		(prompt, surface) => {
			const text = render(prompt, surface);

			expect(text).not.toMatch(UNRUN_CHECK_REPORTING);
			expect(text.split(COVERED_BY_EVIDENCE).length - 1).toBe(1);
			expect(occurrences(text, FEEDBACK_GUIDANCE)).toBe(1);
			expect(intentGate(text)).not.toMatch(FEEDBACK_GUIDANCE);
		},
	);

	it.each(PROMPTS)("%s on the chat surface asks for no handoff block, while app keeps it", (prompt) => {
		const chat = render(prompt, "chat");

		for (const pattern of HANDOFF_TEMPLATE) expect(chat).not.toMatch(pattern);
		expect(chat).not.toMatch(HANDOFF_SLOT);
		expect(render(prompt, "app")).toMatch(HANDOFF_SLOT);
	});

	// senpi#2714: the model copies a format example as the shape of its reply, so a format line written as a
	// markdown quote (`> Ask: ...`, `> I read this as ...`) turned whole answers into blockquotes.
	it.each(PROMPTS)("%s renders no markdown quote line on any surface", (prompt) => {
		for (const surface of ["terminal", "app", "chat"] as const) {
			const quoted = render(prompt, surface)
				.split("\n")
				.filter((line) => line.trimStart().startsWith(">"));

			expect(quoted).toEqual([]);
		}
	});

	it.each(PROMPTS)("%s on the terminal surface keeps the routing line", (prompt) => {
		for (const text of [render(prompt), render(prompt, "terminal")]) {
			expect(text).toContain(ROUTING_LINE_SENTINEL);
			expect(text).not.toMatch(FEEDBACK_GUIDANCE);
		}
	});
});

describe("resolvePromptSurface", () => {
	it("selects the app and chat surfaces only for exactly those values", () => {
		expect(resolvePromptSurface({ SENPI_PROMPT_SURFACE: "app" })).toBe("app");
		expect(resolvePromptSurface({ SENPI_PROMPT_SURFACE: "chat" })).toBe("chat");
		for (const value of [undefined, "", "terminal", "APP", "CHAT", "web"]) {
			expect(resolvePromptSurface({ SENPI_PROMPT_SURFACE: value })).toBe("terminal");
		}
	});
});

describe("SENPI_PROMPT_SURFACE reaches the session prompt", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.unstubAllEnvs();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function createSession(modelId: string): Promise<Harness> {
		const extensionsResult = await createTestExtensionsResult([promptPresetExtension]);
		const harness = await createHarness({
			models: [{ id: modelId, name: modelId, reasoning: true }],
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("ok")]);
		return harness;
	}

	it.each(["gpt-5.5", "unmatched-model"])("renders the app surface for a %s session", async (modelId) => {
		vi.stubEnv("SENPI_PROMPT_SURFACE", "app");
		const harness = await createSession(modelId);

		await harness.session.prompt("hi");

		expect(harness.session.systemPrompt).not.toContain(ROUTING_LINE_SENTINEL);
		expect(harness.session.systemPrompt).toMatch(FEEDBACK_GUIDANCE);
	});

	it.each(["gpt-5.5", "unmatched-model"])("renders the chat surface for a %s session", async (modelId) => {
		vi.stubEnv("SENPI_PROMPT_SURFACE", "chat");
		const harness = await createSession(modelId);

		await harness.session.prompt("hi");

		expect(harness.session.systemPrompt).not.toContain(ROUTING_LINE_SENTINEL);
		expect(harness.session.systemPrompt).not.toMatch(HANDOFF_SLOT);
		expect(harness.session.systemPrompt).toMatch(FEEDBACK_GUIDANCE);
	});

	it("keeps the terminal surface when the variable is unset", async () => {
		vi.stubEnv("SENPI_PROMPT_SURFACE", undefined);
		const harness = await createSession("gpt-5.5");

		await harness.session.prompt("hi");

		expect(harness.session.systemPrompt).toContain(ROUTING_LINE_SENTINEL);
	});
});
