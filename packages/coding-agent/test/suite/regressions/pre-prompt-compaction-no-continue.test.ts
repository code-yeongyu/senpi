import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

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

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	if (!resolve) throw new Error("Deferred resolver was not initialized");
	return { promise, resolve };
}

describe("pre-prompt compaction regression", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("compacts length-stop overflow before a new prompt without continuing from an assistant message", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 100, maxTokens: 100 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "pre-prompt summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		const now = Date.now();
		const model = harness.getModel();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "previous prompt" }],
			timestamp: now - 1000,
		});
		const lengthStopAssistant: AssistantMessage = {
			...fauxAssistantMessage("length-stop assistant response", { stopReason: "length", timestamp: now - 500 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createUsage(100),
		};
		harness.sessionManager.appendMessage(lengthStopAssistant);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage("answered next prompt")]);
		const continueSpy = vi.spyOn(harness.session.agent, "continue");

		await expect(harness.session.prompt("next prompt")).resolves.toBeUndefined();

		expect(continueSpy).not.toHaveBeenCalled();
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: true,
		});
		expect(getUserTexts(harness)).toContain("next prompt");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("blocks the next provider call when required overflow compaction is rejected below the local threshold", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 1_000 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1_000 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({
						cancel: true,
						rejectionCause: "cancelled-by-extension",
						reason: "forced rejection",
					}));
				},
			],
		});
		harnesses.push(harness);

		const now = Date.now();
		const model = harness.getModel();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "earlier prompt" }],
			timestamp: now - 3000,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("earlier response", { timestamp: now - 2000 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createUsage(50),
		});
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "previous prompt" }],
			timestamp: now - 1000,
		});
		const overflowAssistant: AssistantMessage = {
			...fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "context_length_exceeded",
				timestamp: now - 500,
			}),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createUsage(100),
		};
		harness.sessionManager.appendMessage(overflowAssistant);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage("must not reach provider")]);

		await expect(harness.session.prompt("next prompt")).rejects.toThrow(
			"Context remains above the compaction threshold because compaction did not complete",
		);
		await expect(harness.session.prompt("retry prompt")).rejects.toThrow(
			"Context remains above the compaction threshold because compaction did not complete",
		);

		expect(harness.faux.state.callCount).toBe(0);
		expect(getUserTexts(harness)).not.toContain("next prompt");
		expect(getUserTexts(harness)).not.toContain("retry prompt");
		expect(harness.eventsOfType("compaction_end").filter((event) => event.accepted === false)).toHaveLength(2);
		expect(harness.eventsOfType("compaction_end")).toContainEqual(
			expect.objectContaining({
				reason: "overflow",
				accepted: false,
				rejectionCause: "cancelled-by-extension",
			}),
		);
	});

	it("compacts upstream model alias overflow before a dot retry", async () => {
		const harness = await createHarness({
			api: "openai-responses",
			provider: "quotio-openai",
			upstreamModelId: "gpt-5.5",
			models: [{ id: "gpt-5.5-fast", contextWindow: 272_000, maxTokens: 128_000 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "upstream alias pre-prompt summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		const now = Date.now();
		const model = harness.getModel();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "earlier prompt" }],
			timestamp: now - 3000,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("earlier response", { timestamp: now - 2000 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createUsage(50),
		});
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "read /tmp/h2.jpg" }],
			timestamp: now - 1000,
		});
		const overflowAssistant: AssistantMessage = {
			...fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage:
					"Error Code context_too_large: Your input exceeds the context window of this model. Please adjust your input and try again.",
				timestamp: now - 500,
			}),
			api: model.api,
			provider: model.provider,
			model: "gpt-5.5",
			usage: createUsage(0),
		};
		harness.sessionManager.appendMessage(overflowAssistant);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage("recovered after compaction")]);
		const continueSpy = vi.spyOn(harness.session.agent, "continue");

		await expect(harness.session.prompt(".")).resolves.toBeUndefined();

		expect(continueSpy).not.toHaveBeenCalled();
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: true,
			accepted: true,
		});
		expect(getUserTexts(harness)).toContain(".");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("blocks a queued steer continuation when overflow compaction is rejected", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 1_000 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({
						cancel: true,
						rejectionCause: "cancelled-by-extension",
						reason: "forced rejection",
					}));
				},
			],
		});
		harnesses.push(harness);

		const firstTurnStarted = createDeferred();
		const releaseFirstTurn = createDeferred();
		harness.setResponses([
			async () => {
				firstTurnStarted.resolve();
				await releaseFirstTurn.promise;
				// Provider-confirmed overflow: native length stop with zero output and
				// a full context window (the 40_000-char prompt fills the 10_000 window).
				return fauxAssistantMessage("", { stopReason: "length" });
			},
			fauxAssistantMessage("must not reach provider"),
		]);

		const promptPromise = harness.session.prompt("x".repeat(40_000));
		await firstTurnStarted.promise;
		const steerPromise = harness.session.prompt("steered follow-up", { streamingBehavior: "steer" });
		releaseFirstTurn.resolve();

		// The steered continuation must reject at turn admission instead of
		// reaching the provider with the still-overflowing context.
		await expect(promptPromise).rejects.toThrow(
			"Context remains above the compaction threshold because compaction did not complete",
		);
		await steerPromise;
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_end")).toContainEqual(
			expect.objectContaining({
				reason: "overflow",
				accepted: false,
				rejectionCause: "cancelled-by-extension",
			}),
		);
	});

	it("retains native steer and follow-up queues after an error-terminal overflow recovery is rejected", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 1_000 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({
						cancel: true,
						rejectionCause: "cancelled-by-extension",
						reason: "required recovery rejected",
					}));
				},
			],
		});
		harnesses.push(harness);

		const providerStarted = createDeferred();
		const releaseProvider = createDeferred();
		harness.setResponses([
			async () => {
				providerStarted.resolve();
				await releaseProvider.promise;
				return fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "context_length_exceeded",
				});
			},
			fauxAssistantMessage("must not reach provider"),
		]);

		const initialPrompt = harness.session.prompt("x".repeat(40_000));
		await providerStarted.promise;
		await harness.session.prompt("retain native steer", { streamingBehavior: "steer" });
		await harness.session.followUp("retain native follow-up");
		releaseProvider.resolve();

		await expect(initialPrompt).rejects.toThrow(
			"Context remains above the compaction threshold because compaction did not complete",
		);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.getSteeringMessages()).toEqual(["retain native steer"]);
		expect(harness.session.getFollowUpMessages()).toEqual(["retain native follow-up"]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);

		await expect(harness.session.prompt("later normal admission")).rejects.toThrow(
			"Context remains above the compaction threshold because compaction did not complete",
		);
		await expect(
			harness.session.sendCustomMessage(
				{ customType: "extension-note", content: "later custom admission", display: true },
				{ triggerTurn: true },
			),
		).rejects.toThrow("Context remains above the compaction threshold because compaction did not complete");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.getSteeringMessages()).toEqual(["retain native steer"]);
		expect(harness.session.getFollowUpMessages()).toEqual(["retain native follow-up"]);
	});

	it("does not admit agent_end queues that arrive after the first next-turn compaction sample", async () => {
		const firstPrepareSampled = createDeferred();
		const releaseFirstPrepare = createDeferred();
		let prepareCount = 0;
		let queuedAtAgentEnd = false;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 1_000 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			prepareNextTurnWithContext: async () => {
				prepareCount++;
				if (prepareCount === 1) {
					firstPrepareSampled.resolve();
					await releaseFirstPrepare.promise;
				}
				return undefined;
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({
						cancel: true,
						rejectionCause: "cancelled-by-extension",
						reason: "late queue recovery rejected",
					}));
				},
				(pi) => {
					pi.on("agent_end", () => {
						if (queuedAtAgentEnd) return;
						queuedAtAgentEnd = true;
						pi.sendUserMessage("late native follow-up", { deliverAs: "followUp" });
						pi.sendUserMessage("late native steer", { deliverAs: "steer" });
					});
				},
			],
		});
		harnesses.push(harness);

		const model = harness.getModel();
		harness.setResponses([
			{
				...fauxAssistantMessage("", { stopReason: "length" }),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createUsage(10_000),
			},
			fauxAssistantMessage("must not reach provider"),
			fauxAssistantMessage("must not reach provider either"),
		]);

		const prompt = harness.session.prompt("x".repeat(40_000));
		await firstPrepareSampled.promise;
		expect(harness.session.pendingMessageCount).toBe(0);
		releaseFirstPrepare.resolve();
		await expect(prompt).rejects.toThrow(
			"Context remains above the compaction threshold because compaction did not complete",
		);
		await harness.session.waitForSettledSessionWork();

		expect(harness.eventsOfType("compaction_end")).toContainEqual(
			expect.objectContaining({
				reason: "overflow",
				accepted: false,
				rejectionCause: "cancelled-by-extension",
			}),
		);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.getSteeringMessages()).toEqual(["late native steer"]);
		expect(harness.session.getFollowUpMessages()).toEqual(["late native follow-up"]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
	});

	it("blocks sendCustomMessage triggerTurn when overflow compaction is rejected below the local threshold", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 1_000 }],
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1_000 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({
						cancel: true,
						rejectionCause: "cancelled-by-extension",
						reason: "forced rejection",
					}));
				},
			],
		});
		harnesses.push(harness);

		const now = Date.now();
		const model = harness.getModel();
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "earlier prompt" }],
			timestamp: now - 3000,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("earlier response", { timestamp: now - 2000 }),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createUsage(50),
		});
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "previous prompt" }],
			timestamp: now - 1000,
		});
		const overflowAssistant: AssistantMessage = {
			...fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "context_length_exceeded",
				timestamp: now - 500,
			}),
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: createUsage(100),
		};
		harness.sessionManager.appendMessage(overflowAssistant);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage("must not reach provider")]);

		await expect(
			harness.session.sendCustomMessage(
				{ customType: "extension-note", content: "trigger a turn", display: true },
				{ triggerTurn: true },
			),
		).rejects.toThrow("Context remains above the compaction threshold because compaction did not complete");

		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.eventsOfType("compaction_end")).toContainEqual(
			expect.objectContaining({
				reason: "overflow",
				accepted: false,
				rejectionCause: "cancelled-by-extension",
			}),
		);
	});
});
