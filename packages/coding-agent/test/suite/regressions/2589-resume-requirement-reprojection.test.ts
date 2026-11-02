import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { estimateContextTokens } from "../../../src/core/compaction/index.ts";
import { projectModelUsabilityBudget } from "../../../src/core/extensions/builtin/compaction/model-usability-budget.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/index.ts";
import { filterContextExcludedMessages } from "../../../src/core/messages.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import type { InlineExtension } from "../../../src/index.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];

afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

// The resident anthropic-subscription lane: the provider owns automatic compaction (#1174) and
// refuses it as external-owner, while a manual /compact goes through the provider and commits.
function subscriptionLaneOwner(attempts: string[]): InlineExtension {
	return ((pi: ExtensionAPI) => {
		pi.on("session_before_compact", (event) => {
			attempts.push(event.reason);
			if (event.reason === "manual") {
				return {
					compaction: {
						summary: "compacted by the provider",
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
					},
				};
			}
			return { cancel: true, rejectionCause: "external-owner", reason: "provider lane owns compaction" };
		});
	}) as InlineExtension;
}

const LANE_MODELS = [
	{ id: "lane-fallback", contextWindow: 100_000, maxTokens: 4_000 },
	{ id: "lane-primary", contextWindow: 1_000_000, maxTokens: 32_000 },
];

// About 89K tokens: over the resume budget of the 100K-window lane model, still inside its window.
const OVER_BUDGET_REPEAT = 21_000;

const COMPACTION_SETTINGS = {
	compaction: { enabled: true, speculativeEnabled: false, idleCompactionEnabled: false, keepRecentTokens: 1 },
};

function seedTranscript(harness: Harness, earlyTextRepeat: number): void {
	const model = harness.getModel();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "restored context ".repeat(earlyTextRepeat) }],
		timestamp: 1,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("restored answer", { timestamp: 2 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
	});
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "last request" }],
		timestamp: 3,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("last answer", { timestamp: 4 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function admitRequirementAt(harness: Harness, liveContextTokens: number): void {
	const projection = projectModelUsabilityBudget({
		model: harness.getModel(),
		systemPrompt: harness.session.agent.state.systemPrompt,
		tools: harness.session.agent.state.tools,
		liveContextTokens,
		compaction: harness.settingsManager.getCompactionSettings(),
		includeSpeculationLead: false,
		admission: "resume",
	});
	expect(projection.usable).toBe(false);
	harness.session.admitResumeCompactionRequired(projection);
}

function liveContextTokens(harness: Harness): number {
	return estimateContextTokens(filterContextExcludedMessages(harness.sessionManager.buildSessionContext().messages))
		.tokens;
}

async function laneHarness(attempts: string[]): Promise<Harness> {
	const harness = await createHarness({
		models: LANE_MODELS,
		settings: COMPACTION_SETTINGS,
		extensionFactories: [subscriptionLaneOwner(attempts)],
	});
	harnesses.push(harness);
	return harness;
}

describe("#2589/#2488: a stale resume compaction requirement never blocks a prompt that fits", () => {
	it("#given a session resumed on a small fallback model with the requirement #when the primary model is restored and the user prompts #then the prompt is answered without asking the provider lane to compact (#2488)", async () => {
		// given - resume admission on the fallback model records the requirement
		const attempts: string[] = [];
		const harness = await createHarness({ models: LANE_MODELS, persistSession: true, settings: COMPACTION_SETTINGS });
		harnesses.push(harness);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "! ".repeat(95_000 * 2) }],
			timestamp: Date.now(),
		});
		const resourceLoader = createTestResourceLoader({
			extensionsResult: await createTestExtensionsResult([subscriptionLaneOwner(attempts)]),
		});
		const resumed = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: join(harness.tempDir, "resume-agent"),
			model: harness.getModel("lane-fallback"),
			sessionManager: harness.sessionManager,
			authStorage: harness.authStorage,
			modelRegistry: harness.modelRegistry,
			resourceLoader,
		});
		const events: Array<{ type?: string }> = [];
		resumed.session.subscribe((event) => events.push(event));
		await resumed.session.bindExtensions({});
		expect(events.some((event) => event.type === "resume_compaction_required")).toBe(true);
		const primary = harness.getModel("lane-primary");
		if (!primary) throw new Error("expected the primary lane model");
		await resumed.session.setSessionModel(primary);
		harness.setResponses([fauxAssistantMessage("answered on the primary model")]);
		const callsBefore = harness.faux.getCallLog().length;

		// when
		await resumed.session.prompt("continue");

		// then
		expect(harness.faux.getCallLog().length).toBe(callsBefore + 1);
		expect(attempts).toEqual([]);
		resumed.session.dispose();
	});

	it("#given the resident lane with a stale requirement at low usage #when the user prompts #then the prompt is answered and the lane is never asked to compact", async () => {
		// given
		const attempts: string[] = [];
		const harness = await laneHarness(attempts);
		seedTranscript(harness, 50);
		admitRequirementAt(harness, 80_000);
		harness.setResponses([fauxAssistantMessage("answered")]);
		await harness.session.bindExtensions({});

		// when
		await harness.session.prompt("continue");

		// then
		expect(harness.faux.getCallLog()).toHaveLength(1);
		expect(attempts).toEqual([]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("#given the resident lane still over the threshold #when the user prompts #then the refusal is honest, and once a manual /compact commits the next prompt is answered", async () => {
		// given
		const attempts: string[] = [];
		const harness = await laneHarness(attempts);
		seedTranscript(harness, OVER_BUDGET_REPEAT);
		admitRequirementAt(harness, liveContextTokens(harness));
		harness.setResponses([fauxAssistantMessage("answered after compact")]);
		await harness.session.bindExtensions({});

		// when - the lane refuses automatic compaction
		await expect(harness.session.prompt("continue")).rejects.toThrow(
			"Context remains above the compaction threshold",
		);

		// then - nothing reached the provider and senpi did not compact locally
		expect(harness.faux.getCallLog()).toHaveLength(0);
		expect(attempts).toEqual(["pre_prompt"]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);

		// when - the user's manual /compact commits through the lane
		await harness.session.compact();
		await harness.session.prompt("continue");

		// then
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.faux.getCallLog()).toHaveLength(1);
		expect(attempts).toEqual(["pre_prompt", "manual"]);
	});

	it("#given the resident lane over the threshold #when prompts repeat #then automatic compaction stays delegated: asked once, never committed locally (#1174)", async () => {
		// given
		const attempts: string[] = [];
		const harness = await laneHarness(attempts);
		seedTranscript(harness, OVER_BUDGET_REPEAT);
		admitRequirementAt(harness, liveContextTokens(harness));
		await harness.session.bindExtensions({});

		// when
		await expect(harness.session.prompt("first")).rejects.toThrow("Context remains above the compaction threshold");
		await expect(harness.session.prompt("second")).rejects.toThrow("Context remains above the compaction threshold");

		// then
		expect(attempts).toEqual(["pre_prompt"]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(harness.faux.getCallLog()).toHaveLength(0);
	});
});
