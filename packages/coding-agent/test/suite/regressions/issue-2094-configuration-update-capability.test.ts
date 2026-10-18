import { fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// senpi#2094: mid-session effort changes ride a `configuration_update` item for every model
// whose catalog row carries `compat.supportsConfigurationUpdate`, not only for gpt-6-astra.

function withCompat(harness: Harness, modelId: string, supportsConfigurationUpdate: boolean): Model<string> {
	const model = harness.getModel(modelId);
	if (!model) throw new Error(`Missing test model: ${modelId}`);
	if (!supportsConfigurationUpdate) return model;
	const flagged: Model<"openai-responses"> = {
		...model,
		api: "openai-responses",
		compat: { supportsConfigurationUpdate: true },
	};
	return flagged;
}

function configurationUpdateEfforts(harness: Harness): string[] {
	return harness.sessionManager
		.getBranch()
		.flatMap((entry) => (entry.type === "configuration_update" ? [entry.reasoning.effort] : []));
}

async function createOpenAIHarness(options: { compactSummary?: string } = {}): Promise<Harness> {
	const { compactSummary } = options;
	return await createHarness({
		api: "openai-responses",
		provider: "openai",
		models: [
			{ id: "gpt-6-luna", reasoning: true },
			{ id: "gpt-5.5", reasoning: true },
		],
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories:
			compactSummary === undefined
				? []
				: [
						(pi) => {
							pi.on("session_before_compact", async (event) => ({
								compaction: {
									summary: compactSummary,
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
									details: {},
								},
							}));
						},
					],
	});
}

describe("configuration_update follows the catalog capability flag (senpi#2094)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("appends a configuration update and pins the baseline for a flagged model", async () => {
		const harness = await createOpenAIHarness();
		harnesses.push(harness);
		await harness.session.setModel(withCompat(harness, "gpt-6-luna", true));
		harness.session.setThinkingLevel("low");
		const effortsBefore = configurationUpdateEfforts(harness);
		const baseline = harness.agent.state.reasoningBaseline;
		expect(baseline).toBeDefined();

		harness.session.setThinkingLevel("high");

		expect(configurationUpdateEfforts(harness)).toEqual([...effortsBefore, "high"]);
		expect(harness.agent.state.reasoningBaseline).toBe(baseline);
		expect(harness.agent.state.messages.at(-1)?.role).toBe("configurationUpdate");
	});

	it("changes top-level effort for an unflagged model", async () => {
		const harness = await createOpenAIHarness();
		harnesses.push(harness);
		await harness.session.setModel(withCompat(harness, "gpt-5.5", false));
		harness.session.setThinkingLevel("low");

		harness.session.setThinkingLevel("high");

		expect(configurationUpdateEfforts(harness)).toEqual([]);
		expect(harness.agent.state.reasoningBaseline).toBeUndefined();
	});

	it("clears the baseline when switching to an unflagged model", async () => {
		const harness = await createOpenAIHarness();
		harnesses.push(harness);
		await harness.session.setModel(withCompat(harness, "gpt-6-luna", true));
		harness.session.setThinkingLevel("low");
		harness.session.setThinkingLevel("high");
		expect(harness.agent.state.reasoningBaseline).toBeDefined();

		await harness.session.setModel(withCompat(harness, "gpt-5.5", false));

		expect(harness.agent.state.reasoningBaseline).toBeUndefined();
	});

	it("re-appends the latest effort after compaction for a flagged model", async () => {
		const harness = await createOpenAIHarness({ compactSummary: "compacted" });
		harnesses.push(harness);
		await harness.session.setModel(withCompat(harness, "gpt-6-luna", true));
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		harness.session.setThinkingLevel("low");
		await harness.session.prompt("first");
		harness.session.setThinkingLevel("high");
		await harness.session.prompt("second");

		await harness.session.compact();

		const branch = harness.sessionManager.getBranch();
		const compactionIndex = branch.findIndex((entry) => entry.type === "compaction");
		expect(compactionIndex).toBeGreaterThan(-1);
		const afterCompaction = branch.slice(compactionIndex + 1);
		expect(afterCompaction.map((entry) => entry.type)).toEqual(["configuration_update"]);
		expect(configurationUpdateEfforts(harness).at(-1)).toBe("high");
	});

	it("does not re-append an effort after compaction for an unflagged model", async () => {
		const harness = await createOpenAIHarness({ compactSummary: "compacted" });
		harnesses.push(harness);
		await harness.session.setModel(withCompat(harness, "gpt-6-luna", true));
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		harness.session.setThinkingLevel("low");
		await harness.session.prompt("first");
		harness.session.setThinkingLevel("high");
		await harness.session.setModel(withCompat(harness, "gpt-5.5", false));
		await harness.session.prompt("second");

		await harness.session.compact();

		const branch = harness.sessionManager.getBranch();
		const compactionIndex = branch.findIndex((entry) => entry.type === "compaction");
		expect(compactionIndex).toBeGreaterThan(-1);
		expect(branch.slice(compactionIndex + 1).some((entry) => entry.type === "configuration_update")).toBe(false);
	});
});
