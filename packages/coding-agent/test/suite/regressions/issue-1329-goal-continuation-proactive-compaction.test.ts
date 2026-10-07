import type { AssistantMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import compactionExtension from "../../../src/core/extensions/builtin/compaction/index.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

/**
 * code-yeongyu/senpi#1329: a hidden goal continuation is an idle trigger-turn
 * custom message (`pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`).
 * That route never emitted `before_agent_start`, so the compaction extension's
 * proactive policy (`threshold_trigger` -> warm-summary consumption) never ran
 * for it; the session rode from the proactive threshold up to the hard reserve
 * valve and then paid a from-scratch blocking summarization inside the turn.
 * An explicit user prompt at the same usage compacts before the provider call.
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

const WAKE_TEXT = "Continue working toward the active thread goal.";

async function seedIdleSessionAboveThreshold(): Promise<{ harness: Harness; trace: string[] }> {
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
	// The wake turn is the only provider request that carries the continuation
	// text; the summarization request is built before the wake message is
	// admitted, so it never contains it.
	harness.setResponses([
		(context) => {
			const isWake = context.messages.some((message) => getMessageText(message) === WAKE_TEXT);
			trace.push(isWake ? "provider_request" : "summary_request");
			return fauxAssistantMessage(isWake ? "wake complete" : "compaction summary");
		},
		(context) => {
			const isWake = context.messages.some((message) => getMessageText(message) === WAKE_TEXT);
			trace.push(isWake ? "provider_request" : "summary_request");
			return fauxAssistantMessage(isWake ? "wake complete" : "compaction summary");
		},
	]);
	return { harness, trace };
}

describe("issue #1329: idle goal continuations run through the proactive compaction policy", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("compacts before the provider request of a trigger-turn custom message above the proactive threshold", async () => {
		const { harness, trace } = await seedIdleSessionAboveThreshold();
		harnesses.push(harness);
		expect(harness.session.isIdle).toBe(true);

		await harness.session.sendCustomMessage(
			{ customType: "goal-continuation", content: WAKE_TEXT, display: false },
			{ triggerTurn: true, deliverAs: "followUp" },
		);

		expect(trace).toContain("provider_request");
		expect(trace.indexOf("compaction_start")).toBeGreaterThanOrEqual(0);
		expect(trace.indexOf("compaction_start")).toBeLessThan(trace.indexOf("provider_request"));
	});

	it("keeps the explicit user prompt path compacting at the same usage", async () => {
		const { harness, trace } = await seedIdleSessionAboveThreshold();
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
