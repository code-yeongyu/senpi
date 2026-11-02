import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import compactionExtension from "../../../src/core/extensions/builtin/compaction/index.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * code-yeongyu/oh-my-openagent#7921 case 4: an automatic continuation (a queued
 * follow-up drained at agent_end) whose context sits above the proactive
 * threshold but below the hard reserve limit reached the provider without
 * compacting, while an explicit user prompt at the same usage compacts first.
 */

function createUsage(totalTokens: number) {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createAssistant(harness: Harness, totalTokens: number, text: string, timestamp: number): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage(text, { stopReason: "stop", timestamp }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(totalTokens),
	};
}

/** Strictly between the proactive threshold (0.6 * window) and the hard limit (window - reserve). */
function tokensAboveThresholdBelowHardLimit(harness: Harness): number {
	const contextWindow = harness.getModel().contextWindow ?? 128_000;
	const reserveTokens = harness.settingsManager.getCompactionSettings().reserveTokens;
	const threshold = Math.ceil(contextWindow * 0.6);
	const hardLimit = contextWindow - reserveTokens;
	const tokens = Math.floor((threshold + hardLimit) / 2);
	if (!(tokens > threshold && tokens < hardLimit)) {
		throw new Error(`test setup produced tokens ${tokens} outside (${threshold}, ${hardLimit})`);
	}
	return tokens;
}

async function seedContextAboveThreshold(): Promise<{ harness: Harness; trace: string[] }> {
	const harness = await createHarness({
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [compactionExtension],
	});
	const now = Date.now();
	const overThreshold = tokensAboveThresholdBelowHardLimit(harness);
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "seed prompt" }],
		timestamp: now - 3_000,
	});
	harness.sessionManager.appendMessage(createAssistant(harness, overThreshold, "seed response", now - 2_000));
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "kept prompt" }],
		timestamp: now - 1_000,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

	const trace: string[] = [];
	harness.session.subscribe((event) => {
		if (event.type === "compaction_start") trace.push("compaction_start");
	});
	return { harness, trace };
}

describe("#7921 case 4: automatic continuations run through the proactive policy", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("compacts before the provider request that drains a queued follow-up above the proactive threshold", async () => {
		const { harness, trace } = await seedContextAboveThreshold();
		harnesses.push(harness);

		harness.setResponses([
			() => {
				trace.push("summary_request");
				return fauxAssistantMessage("compaction summary");
			},
		]);
		harness.session.agent.followUp({
			role: "user",
			content: [{ type: "text", text: "queued follow-up" }],
			timestamp: Date.now(),
		});
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);

		vi.spyOn(harness.session.agent, "continue").mockImplementation(async () => {
			trace.push("provider_request");
		});
		vi.spyOn(harness.session.agent, "continueWithQueuedMessages").mockImplementation(async () => {
			trace.push("provider_request");
		});

		const continueAfterRun = Reflect.get(harness.session, "_continueAgentAfterCurrentRun");
		if (typeof continueAfterRun !== "function") {
			throw new Error("AgentSession._continueAgentAfterCurrentRun is not available");
		}
		await continueAfterRun.call(harness.session, {});

		expect(trace).toContain("provider_request");
		expect(trace.indexOf("compaction_start")).toBeGreaterThanOrEqual(0);
		expect(trace.indexOf("compaction_start")).toBeLessThan(trace.indexOf("provider_request"));
	});

	it("keeps the explicit user prompt path compacting at the same usage", async () => {
		const { harness, trace } = await seedContextAboveThreshold();
		harnesses.push(harness);

		harness.setResponses([
			() => {
				trace.push("summary_request");
				return fauxAssistantMessage("compaction summary");
			},
			() => {
				trace.push("provider_request");
				return fauxAssistantMessage("answer");
			},
		]);

		await harness.session.prompt("explicit user prompt");

		expect(trace).toContain("provider_request");
		expect(trace.indexOf("compaction_start")).toBeGreaterThanOrEqual(0);
		expect(trace.indexOf("compaction_start")).toBeLessThan(trace.indexOf("provider_request"));
	});
});
