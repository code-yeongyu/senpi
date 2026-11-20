import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	PROMPT_PRESET_MODEL_CASES,
	presetHandoffCueKind,
} from "../../src/core/extensions/builtin/prompt-preset/contract.ts";
import { type PromptPresetSettings, resolvePreset } from "../../src/core/extensions/builtin/prompt-preset/presets.ts";
import todotoolsExtension from "../../src/core/extensions/builtin/todotools/index.ts";
import {
	GPT_HANDOFF_CUES,
	GPT_HANDOFF_LABELS,
	HANDOFF_CUES,
	handoffMomentOf,
	type TodoPhase,
} from "../../src/core/extensions/builtin/todotools/state.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

function createModel(id: string, provider = "openai"): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-responses",
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

afterEach(() => {
	vi.unstubAllEnvs();
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

function phases(...spec: Array<[string, ...Array<[string, TodoPhase["tasks"][number]["status"]]>]>): TodoPhase[] {
	return spec.map(([name, ...tasks]) => ({ name, tasks: tasks.map(([content, status]) => ({ content, status })) }));
}

describe("handoffMomentOf", () => {
	const open = phases(["Build", ["a", "in_progress"], ["b", "pending"]], ["Check", ["c", "pending"]]);

	it("reports list-created for a list-creating call with tasks", () => {
		// given: no list before, a list after
		// when/then
		expect(handoffMomentOf([], open, true)).toBe("list-created");
	});

	it("reports phase-closed when the last open task of a phase closes", () => {
		// given: Build has one open task left
		const before = phases(["Build", ["a", "completed"], ["b", "in_progress"]], ["Check", ["c", "pending"]]);
		const after = phases(["Build", ["a", "completed"], ["b", "completed"]], ["Check", ["c", "in_progress"]]);
		// when/then
		expect(handoffMomentOf(before, after, false)).toBe("phase-closed");
	});

	it("reports all-closed when the last open task of the list closes, dropped tasks included", () => {
		// given: one open task left in the whole list
		const before = phases(["Build", ["a", "completed"], ["b", "completed"]], ["Check", ["c", "in_progress"]]);
		const after = phases(["Build", ["a", "completed"], ["b", "completed"]], ["Check", ["c", "abandoned"]]);
		// when/then
		expect(handoffMomentOf(before, after, false)).toBe("all-closed");
	});

	it("reports nothing for a mid-phase transition or an already-closed list", () => {
		// given: a task closes while its phase still has open work; a closed list stays closed
		const midAfter = phases(["Build", ["a", "completed"], ["b", "in_progress"]], ["Check", ["c", "pending"]]);
		const closed = phases(["Build", ["a", "completed"]]);
		// when/then
		expect(handoffMomentOf(open, midAfter, false)).toBeUndefined();
		expect(handoffMomentOf(closed, closed, false)).toBeUndefined();
		expect(handoffMomentOf([], [], true)).toBeUndefined();
	});
});

async function runFourTodoCalls(modelId?: string): Promise<string[]> {
	const harness = await createHarness({
		extensionFactories: [todotoolsExtension],
		...(modelId === undefined ? {} : { models: [{ id: modelId }] }),
	});
	harnesses.push(harness);
	const targetModel = modelId === undefined ? undefined : harness.getModel(modelId);
	if (targetModel) await harness.session.setModel(targetModel);
	harness.setResponses([
		fauxAssistantMessage(
			[
				fauxToolCall("todo", {
					op: "init",
					list: [
						{ phase: "Build", items: ["a", "b"] },
						{ phase: "Check", items: ["c"] },
					],
				}),
			],
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage([fauxToolCall("todo", { op: "done", task: "a" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("todo", { op: "done", task: "b" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("todo", { op: "done", task: "c" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("ok"),
	]);

	await harness.session.prompt("Build a, b, then check c.");
	return harness.session.messages.flatMap((message) =>
		message.role === "toolResult" && message.toolName === "todo" ? [getMessageText(message)] : [],
	);
}

describe("todo results carry the handoff cue at handoff moments", () => {
	it.each(["terminal", "app"])(
		"appends the list-created, phase-closed, and all-closed cues and nothing mid-phase on %s",
		async (surface) => {
			// given: a session running four todo calls in one turn
			vi.stubEnv("SENPI_PROMPT_SURFACE", surface);

			// when
			const texts = await runFourTodoCalls();

			// then: each result ends with the cue for its moment, and the mid-phase done carries none
			expect(texts).toHaveLength(4);
			expect(texts[0]?.endsWith(HANDOFF_CUES["list-created"])).toBe(true);
			expect(Object.values(HANDOFF_CUES).some((cue) => texts[1]?.includes(cue))).toBe(false);
			expect(texts[2]?.endsWith(HANDOFF_CUES["phase-closed"])).toBe(true);
			expect(texts[3]?.endsWith(HANDOFF_CUES["all-closed"])).toBe(true);
		},
	);

	it("carries no cue on the chat surface, which has no handoff block (senpi#2398)", async () => {
		// given: the same four calls in a chat-surface session
		vi.stubEnv("SENPI_PROMPT_SURFACE", "chat");

		// when
		const texts = await runFourTodoCalls();

		// then: the todo results still report the list, and none carries a handoff cue
		expect(texts).toHaveLength(4);
		for (const text of texts) expect(text).not.toContain("Handoff due");
	});
});

describe("the cue names the handoff block the active preset defines (senpi#6977)", () => {
	it("names the Outcome / You need block under a GPT preset that renders it", async () => {
		// given: a session on a model whose prompt renders the GPT family handoff block
		vi.stubEnv("SENPI_PROMPT_SURFACE", "terminal");

		// when
		const texts = await runFourTodoCalls("gpt-6-astra");

		// then: each handoff-moment result cues that block's labels, and no cue names the default Ask / For you block
		expect(texts).toHaveLength(4);
		for (const text of [texts[0], texts[2]]) {
			expect(text).toContain("Handoff due");
			expect(text).toContain(`${GPT_HANDOFF_LABELS} handoff block`);
			expect(text).not.toContain("Ask / For you / Now / Next");
		}
		expect(texts[3]).toContain("Handoff due");
		expect(texts[3]).toContain("goes inside You need");
		expect(texts[3]).not.toContain("Ask / For you / Now / Next");
		expect(texts[1]).not.toContain("Handoff due");
	});

	it.each(["gpt-6.2-astra", "deepseek-flash"])(
		"emits no cue under %s, whose prompt defines no handoff block",
		async (id) => {
			// given: a session on a preset whose core defines no handoff block on any surface (senpi#6979, senpi#7100)
			vi.stubEnv("SENPI_PROMPT_SURFACE", "terminal");

			// when
			const texts = await runFourTodoCalls(id);

			// then: the todo results still report the list, and none carries a handoff cue
			expect(texts).toHaveLength(4);
			for (const text of texts) expect(text).not.toContain("Handoff due");
		},
	);

	it("maps every preset to the cue kind its rendered prompt implies", () => {
		// given: the preset case table covers every preset family; the expectation is DERIVED from
		// each case's rendered prompt (the outcome-first block maps to gpt-block, the Ask block to default,
		// neither to none), so a preset that starts or stops rendering a block fails here until the table
		// is set deliberately
		for (const { providerID, modelID, preset } of PROMPT_PRESET_MODEL_CASES) {
			const prompt = resolvePreset(createModel(modelID, providerID), AUTO)?.prompt ?? "";
			const expected = prompt.includes("[Outcome so far] toward")
				? "gpt-block"
				: prompt.includes("Ask: [the user's original request]")
					? "default"
					: "none";
			expect(presetHandoffCueKind(preset), preset).toBe(expected);
		}
		expect(presetHandoffCueKind(undefined)).toBe("default");
	});

	it("names the GPT handoff labels the prompts that render the block carry", () => {
		// given: the three presets that render the GPT block, and the cue's own label list
		// then: every label the cue names appears in each rendered prompt, so renaming a label
		// in the cue without the prompt (or vice versa) fails here
		const labels = GPT_HANDOFF_LABELS.split(" / ");
		expect(labels).toEqual(["Outcome so far", "You need", "Now", "Next"]);
		for (const id of ["gpt-5.5", "gpt-5.6", "gpt-6-astra"]) {
			const prompt = resolvePreset(createModel(id), AUTO)?.prompt ?? "";
			for (const label of labels) expect(prompt, `${id}: ${label}`).toContain(label);
		}
		for (const cue of Object.values(GPT_HANDOFF_CUES)) {
			expect(cue).toContain(GPT_HANDOFF_LABELS);
		}
	});
});
