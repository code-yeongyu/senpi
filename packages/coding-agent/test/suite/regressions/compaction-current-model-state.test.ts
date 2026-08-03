import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { Context, FauxResponseFactory } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import compactionExtension from "../../../src/core/extensions/builtin/compaction/index.ts";
import { createHarness, getAssistantTexts, getMessageText, type Harness } from "../harness.ts";

/**
 * The compaction extension delivers its post-compact restoration payload as a
 * hidden custom message, which reaches the provider as a trailing user message
 * after the real prompt. Skip it so response routing still keys off the prompt.
 */
const HIDDEN_RESTORATION_PREFIX = "[restore checkpointed session agent configuration after compaction]";

function lastUserText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message?.role !== "user") continue;
		const text = getMessageText(message);
		if (text.startsWith(HIDDEN_RESTORATION_PREFIX)) continue;
		return text;
	}
	return "";
}

function runAutoCompaction(harness: Harness, reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
	const run = Reflect.get(harness.session, "_runAutoCompaction");
	if (typeof run !== "function") throw new Error("Expected AgentSession._runAutoCompaction");
	return Promise.resolve(run.call(harness.session, reason, willRetry));
}

function seedLargeContext(harness: Harness): void {
	const model = harness.getModel("faux-1");
	if (!model) throw new Error("Primary model was not registered");
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "history ".repeat(22_000) }],
		timestamp: now - 1000,
	});
	harness.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "result ".repeat(200) }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 19_900,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: now - 500,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("Regression: compaction state during model fallback", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("uses the active main-thread fallback model for compaction", async () => {
		const harness = await createHarness({
			models: [
				{ id: "faux-1", contextWindow: 50_000, maxTokens: 2048 },
				{ id: "faux-2", contextWindow: 50_000, maxTokens: 2048 },
			],
			settings: {
				compaction: {
					enabled: true,
					reserveTokens: 5000,
					keepRecentTokens: 32,
					speculativeEnabled: false,
				},
				retry: {
					enabled: true,
					maxRetries: 0,
					baseDelayMs: 1,
					fallbackChains: { "faux/faux-1": ["faux/faux-2"] },
				},
			},
			extensionFactories: [compactionExtension],
		});
		harnesses.push(harness);
		seedLargeContext(harness);

		const response: FauxResponseFactory = async (context, _options, _state, model) => {
			const prompt = lastUserText(context);
			if (prompt === "trigger fallback") {
				if (model.id === "faux-1") {
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
				}
				return fauxAssistantMessage("fallback answer");
			}
			if (prompt === "prompt after compaction") return fauxAssistantMessage("next answer");
			return fauxAssistantMessage("compacted on active fallback");
		};
		harness.setResponses([response, response, response, response]);

		await harness.session.prompt("trigger fallback");
		const compactionModels = harness.faux
			.getCallLog()
			.filter((entry) => !["trigger fallback", "prompt after compaction"].includes(lastUserText(entry.context)))
			.map((entry) => entry.modelId);

		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([
			{ from: "faux/faux-1", to: "faux/faux-2" },
		]);
		expect(compactionModels).toEqual(["faux-2"]);
		expect(harness.session.model?.id).toBe("faux-2");
		expect(Reflect.get(harness.session, "compactionState")).toMatchObject({
			status: "completed",
			generation: 1,
			model: { provider: "faux", id: "faux-2" },
		});

		await harness.session.prompt("prompt after compaction");
		expect(getAssistantTexts(harness)).toContain("next answer");
		expect(harness.session.model?.id).toBe("faux-2");
	});

	it.each(["rejected", "accepted"] as const)(
		"revalidates the model selected by a delayed session_compact handler before queued continuation when re-compaction is %s",
		async (secondCompaction) => {
			const continuationMarker = `queued continuation after ${secondCompaction} smaller-model revalidation`;
			const firstSummary = "large-window summary ".repeat(80);
			let compactionRequests = 0;
			let smallerModel: Harness["models"][number] | undefined;
			let resolveFirstCompactionEnd: (() => void) | undefined;
			const firstCompactionEnd = new Promise<void>((resolve) => {
				resolveFirstCompactionEnd = resolve;
			});
			const compactionEndModels: string[] = [];
			const providerCompactionCounts: number[] = [];
			let switchedToSmallerModel = false;
			const harness = await createHarness({
				models: [
					{ id: "large", contextWindow: 1_000, maxTokens: 64 },
					{ id: "small", contextWindow: 100, maxTokens: 64 },
				],
				settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 } },
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", (event) => {
							compactionRequests++;
							if (compactionRequests === 2 && secondCompaction === "rejected") {
								return {
									cancel: true,
									rejectionCause: "cancelled-by-extension" as const,
									reason: "smaller model requires a rejected second compaction",
								};
							}
							return {
								compaction: {
									summary: compactionRequests === 1 ? firstSummary : "small-window replacement summary",
									firstKeptEntryId: event.preparation.firstKeptEntryId,
									tokensBefore: event.preparation.tokensBefore,
								},
							};
						});
						pi.on("session_compact", async (event) => {
							if (!event.accepted || switchedToSmallerModel) return;
							await firstCompactionEnd;
							pi.sendMessage({
								customType: "post-compaction-state",
								content: "first post-compaction state",
								display: false,
							});
							pi.sendMessage({
								customType: "post-compaction-state",
								content: "second post-compaction state",
								display: false,
							});
							if (!smallerModel) throw new Error("Expected smaller model");
							switchedToSmallerModel = await pi.setModel(smallerModel);
						});
					},
				],
			});
			harnesses.push(harness);
			smallerModel = harness.getModel("small");
			if (!smallerModel) throw new Error("Expected smaller model");
			const largeModel = harness.getModel("large");
			if (!largeModel) throw new Error("Expected large model");
			const timestamp = Date.now();
			harness.sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "large context before compaction ".repeat(120) }],
				timestamp: timestamp - 1,
			});
			harness.sessionManager.appendMessage({
				...fauxAssistantMessage("large context response"),
				api: largeModel.api,
				provider: largeModel.provider,
				model: largeModel.id,
				usage: {
					input: 900,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 900,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp,
			});
			harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			harness.setResponses([
				() => {
					providerCompactionCounts.push(
						harness.eventsOfType("compaction_end").filter((event) => event.accepted === true).length,
					);
					return fauxAssistantMessage("queued continuation handled");
				},
			]);
			harness.session.subscribe((event) => {
				if (event.type === "compaction_end" && event.accepted && event.reason === "threshold") {
					compactionEndModels.push(harness.session.model?.id ?? "none");
					resolveFirstCompactionEnd?.();
				}
			});
			await harness.session.followUp(continuationMarker);

			await runAutoCompaction(harness, "threshold", false);
			await harness.session.waitForSettledSessionWork();

			expect(compactionEndModels[0]).toBe("large");
			expect(switchedToSmallerModel).toBe(true);
			expect(harness.session.model?.id).toBe("small");
			if (secondCompaction === "rejected") {
				expect(harness.faux.state.callCount).toBe(0);
				expect(providerCompactionCounts).toEqual([]);
				expect(compactionRequests).toBe(2);
				expect(harness.session.getFollowUpMessages()).toEqual([continuationMarker]);
				expect(harness.session.agent.hasQueuedMessages()).toBe(true);
			} else {
				expect(compactionRequests).toBe(2);
				expect(providerCompactionCounts).toEqual([2]);
				expect(harness.faux.state.callCount).toBe(1);
			}
		},
	);
});
