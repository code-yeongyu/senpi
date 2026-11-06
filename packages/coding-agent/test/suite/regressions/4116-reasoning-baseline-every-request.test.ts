import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { ModelUsabilityBudgetError } from "../../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import { resumeReasoningBaseline } from "../../../src/core/reasoning-baseline.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness, type HarnessOptions } from "../harness.ts";

// senpi#4116: once a session holds a configuration_update, every request must carry the same request-level
// effort (the baseline) and effort changes travel only as configuration_update items. The first request of a
// run carried the baseline while every later request of the same run carried the live level, splitting the
// prompt cache; and a switch to another model kept the previous model's level as the new model's baseline.

function echoTool(): AgentTool {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo text back",
		parameters: Type.Object({ text: Type.String() }),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
	};
}

function flagged(harness: Harness, modelId: string): Model<string> {
	const model = harness.getModel(modelId);
	if (!model) throw new Error(`Missing test model: ${modelId}`);
	const withCapability: Model<"openai-responses"> = {
		...model,
		api: "openai-responses",
		compat: { supportsConfigurationUpdate: true },
	};
	return withCapability;
}

/** Flags every model in the runtime catalog, so the favorites a cycle resolves there take `configuration_update`. */
function flagCatalog(harness: Harness): void {
	harness.modelRegistry.registerProvider("openai", {
		baseUrl: harness.getModel().baseUrl,
		apiKey: "faux-key",
		api: "openai-responses",
		models: harness.models.map((model) => ({
			id: model.id,
			name: model.name,
			api: "openai-responses",
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			baseUrl: model.baseUrl,
			compat: { supportsConfigurationUpdate: true },
		})),
	});
}

function recording(sent: Array<string | undefined>, step: "tool" | "text"): FauxResponseFactory {
	return (_context, options) => {
		sent.push(options?.reasoning);
		return step === "tool"
			? fauxAssistantMessage([fauxToolCall("echo", { text: "x" })], { stopReason: "toolUse" })
			: fauxAssistantMessage("done");
	};
}

describe("reasoning baseline on every request (senpi#4116)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function openAIHarness(extensionFactories?: HarnessOptions["extensionFactories"]): Promise<Harness> {
		const harness = await createHarness({
			api: "openai-responses",
			provider: "openai",
			models: [
				{ id: "gpt-6-luna", reasoning: true, contextWindow: 100_000, maxTokens: 4_000 },
				{ id: "gpt-6-sol", reasoning: true, contextWindow: 100_000, maxTokens: 4_000 },
			],
			tools: [echoTool()],
			...(extensionFactories === undefined ? {} : { extensionFactories }),
		});
		harnesses.push(harness);
		return harness;
	}

	/** On luna with baseline `medium` and live level `high`; favorites cycle luna -> sol at `xhigh`. */
	async function onLunaWithBaseline(harness: Harness): Promise<void> {
		flagCatalog(harness);
		harness.session.setThinkingLevel("medium");
		const luna = flagged(harness, "gpt-6-luna");
		await harness.session.setModel(luna);
		harness.session.setThinkingLevel("high");
		expect(harness.agent.state.reasoningBaseline).toBe("medium");
		harness.session.setFavoriteModels([
			{ model: luna },
			{ model: flagged(harness, "gpt-6-sol"), thinkingLevel: "xhigh" },
		]);
	}

	it("Given a favorite cycle from a flagged model to another flagged model when it runs then it sends its own level and keeps no baseline from the previous model", async () => {
		// Given
		const harness = await openAIHarness();
		await onLunaWithBaseline(harness);

		// When
		const cycled = await harness.session.cycleModel();
		const sent: Array<string | undefined> = [];
		harness.setResponses([recording(sent, "tool"), recording(sent, "text")]);
		await harness.session.prompt("after cycle");

		// Then
		expect(cycled?.model.id).toBe("gpt-6-sol");
		expect(harness.agent.state.thinkingLevel).toBe("xhigh");
		expect(harness.agent.state.reasoningBaseline).toBeUndefined();
		expect(sent).toEqual(["xhigh", "xhigh"]);
		expect(resumeReasoningBaseline(harness.sessionManager.getBranch())).toBeUndefined();
	});

	it("Given a favorite cycle refused after model_select when it rethrows then the session keeps the baseline it came in with", async () => {
		// Given
		const harness = await openAIHarness([
			(pi) => {
				pi.on("model_select", (event) =>
					event.model.id === "gpt-6-sol" ? { systemPrompt: "large ".repeat(100_000) } : undefined,
				);
			},
		]);
		await onLunaWithBaseline(harness);

		// When
		await expect(harness.session.cycleModel()).rejects.toBeInstanceOf(ModelUsabilityBudgetError);

		// Then
		expect(harness.session.model?.id).toBe("gpt-6-luna");
		expect(harness.agent.state.reasoningBaseline).toBe("medium");
	});

	it("Given an effort change on a flagged model when a run makes tool calls then every request carries the baseline", async () => {
		// Given
		const harness = await openAIHarness();
		harness.session.setThinkingLevel("medium");
		await harness.session.setModel(flagged(harness, "gpt-6-luna"));
		harness.session.setThinkingLevel("high");
		const baseline = harness.agent.state.reasoningBaseline;
		expect(baseline).toBe("medium");
		const sent: Array<string | undefined> = [];
		harness.setResponses([recording(sent, "tool"), recording(sent, "tool"), recording(sent, "text")]);

		// When
		await harness.session.prompt("first");
		harness.appendResponses([recording(sent, "text")]);
		await harness.session.prompt("second");

		// Then
		expect(sent).toEqual([baseline, baseline, baseline, baseline]);
	});

	it("Given a switch to another flagged model when it runs then it sends its own level and keeps no baseline from the previous model", async () => {
		// Given
		const harness = await openAIHarness();
		harness.session.setThinkingLevel("medium");
		await harness.session.setModel(flagged(harness, "gpt-6-luna"));
		harness.settingsManager.setModelThinkingLevel("openai", "gpt-6-sol", "xhigh");

		// When
		await harness.session.setModel(flagged(harness, "gpt-6-sol"));
		const sent: Array<string | undefined> = [];
		harness.setResponses([recording(sent, "tool"), recording(sent, "text")]);
		await harness.session.prompt("after switch");

		// Then
		expect(harness.agent.state.thinkingLevel).toBe("xhigh");
		expect(harness.agent.state.reasoningBaseline).toBeUndefined();
		expect(sent).toEqual(["xhigh", "xhigh"]);

		// When: an effort change on the new model pins the level the new model has been running at.
		harness.session.setThinkingLevel("high");
		harness.appendResponses([recording(sent, "tool"), recording(sent, "text")]);
		await harness.session.prompt("after change");

		// Then
		expect(harness.agent.state.reasoningBaseline).toBe("xhigh");
		expect(sent).toEqual(["xhigh", "xhigh", "xhigh", "xhigh"]);
	});
});

describe("resumeReasoningBaseline (senpi#4116)", () => {
	let clock = 0;
	function entries(...values: Array<Record<string, unknown> & { type: string }>): SessionEntry[] {
		let parentId: string | null = null;
		return values.map((value) => {
			const id = `e${++clock}`;
			const entry = { id, parentId, timestamp: new Date(clock).toISOString(), ...value } as SessionEntry;
			parentId = id;
			return entry;
		});
	}
	const level = (thinkingLevel: string) => ({ type: "thinking_level_change", thinkingLevel });
	const update = (effort: string) => ({ type: "configuration_update", reasoning: { effort } });
	const switchTo = (modelId: string) => ({ type: "model_change", provider: "openai", modelId });
	const user = { type: "message", message: { role: "user", content: "hi", timestamp: 1 } };

	it.each([
		["an in-model change pins the level before it", [level("medium"), user, level("high"), update("high")], "medium"],
		[
			"a later in-model change keeps the first baseline",
			[level("medium"), level("high"), update("high"), level("low"), update("low")],
			"medium",
		],
		[
			"an update written with a switch is cleared by that switch",
			[switchTo("a"), level("medium"), user, level("xhigh"), update("xhigh"), switchTo("b")],
			undefined,
		],
		[
			"an in-model change after a switch pins the new model's level",
			[
				switchTo("a"),
				level("medium"),
				level("xhigh"),
				update("xhigh"),
				switchTo("b"),
				user,
				level("high"),
				update("high"),
			],
			"xhigh",
		],
		[
			"a post-compaction re-append is not a baseline",
			[
				switchTo("a"),
				level("medium"),
				level("xhigh"),
				update("xhigh"),
				switchTo("b"),
				{ type: "compaction" },
				update("xhigh"),
			],
			undefined,
		],
		[
			"a model change to the same model keeps the baseline",
			[switchTo("a"), level("medium"), level("high"), update("high"), switchTo("a")],
			"medium",
		],
	] as const)("%s", (_name, values, expected) => {
		expect(resumeReasoningBaseline(entries(...values))).toBe(expected);
	});
});
