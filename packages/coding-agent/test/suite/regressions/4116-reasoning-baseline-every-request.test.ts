import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseFactory, fauxAssistantMessage, fauxToolCall, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { resumeReasoningBaseline } from "../../../src/core/reasoning-baseline.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import { createHarness, type Harness } from "../harness.ts";

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

	async function openAIHarness(): Promise<Harness> {
		const harness = await createHarness({
			api: "openai-responses",
			provider: "openai",
			models: [
				{ id: "gpt-6-luna", reasoning: true },
				{ id: "gpt-6-sol", reasoning: true },
			],
			tools: [echoTool()],
		});
		harnesses.push(harness);
		return harness;
	}

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
