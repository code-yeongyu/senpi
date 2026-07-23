import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

const primary = "faux/faux-1";
const fallback = "faux/faux-2";

type EventTranscriptEntry =
	| { type: "message_start" | "message_end"; role: string }
	| { type: "message_update"; update: string }
	| { type: "agent_end"; willRetry: boolean }
	| {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| {
			type: "auto_retry_end";
			success: boolean;
			attempt: number;
			finalError?: string;
	  }
	| { type: string };

function retryTranscript(events: Harness["events"]): EventTranscriptEntry[] {
	return events.map((event) => {
		switch (event.type) {
			case "message_start":
			case "message_end":
				return { type: event.type, role: event.message.role };
			case "message_update":
				return { type: event.type, update: event.assistantMessageEvent.type };
			case "agent_end":
				return { type: event.type, willRetry: event.willRetry };
			case "auto_retry_start":
				return {
					type: event.type,
					attempt: event.attempt,
					maxAttempts: event.maxAttempts,
					delayMs: event.delayMs,
					errorMessage: event.errorMessage,
				};
			case "auto_retry_end":
				return {
					type: event.type,
					success: event.success,
					attempt: event.attempt,
					...(event.finalError === undefined ? {} : { finalError: event.finalError }),
				};
			default:
				return { type: event.type };
		}
	});
}

describe("retry fallback engine", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		while (harnesses.length) harnesses.pop()?.cleanup();
	});

	it("switches immediately to a configured fallback and reports success", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					baseDelayMs: 100,
					fallbackChains: { [primary]: [fallback] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "overloaded_error",
			}),
			fauxAssistantMessage("fallback answer"),
		]);

		await harness.session.prompt("hello");

		expect(harness.eventsOfType("auto_retry_start").map((event) => event.delayMs)).toEqual([0]);
		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([
			{ from: primary, to: fallback, chainKey: primary },
		]);
		expect(harness.eventsOfType("retry_fallback_succeeded")).toMatchObject([{ model: fallback, chainKey: primary }]);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("agent_end").map((event) => event.willRetry)).toEqual([true, false]);
	});

	it("rebuilds model-scoped prompt and tools through an explicit fallback model_select", async () => {
		const primaryPrivilegedTool: AgentTool = {
			name: "primary_privileged",
			label: "Primary Privileged",
			description: "Must never remain active after a fallback switch.",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "primary" }], details: {} }),
		};
		const fallbackPresetTool: AgentTool = {
			name: "fallback_preset",
			label: "Fallback Preset",
			description: "Only available through the fallback model preset.",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "fallback" }], details: {} }),
		};
		const modelSelectSources: string[] = [];
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			tools: [primaryPrivilegedTool, fallbackPresetTool],
			initialActiveToolNames: ["primary_privileged"],
			settings: { retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } } },
			extensionFactories: [
				(pi) => {
					pi.on("model_select", (event) => {
						modelSelectSources.push(`${event.previousModel?.id ?? "none"}->${event.model.id}:${event.source}`);
						if (event.model.id !== "faux-2") return undefined;
						pi.setActiveTools(["fallback_preset"]);
						return { systemPrompt: "fallback preset system prompt", systemPromptName: "fallback-preset" };
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("first")]);
		await harness.session.prompt("first turn");

		let stateBeforeFailedAssistant: typeof harness.session.state.messages | undefined;
		let fallbackRequestMessages: unknown;
		let stateAtFallbackRequest: typeof harness.session.state.messages | undefined;
		let fallbackRequestSystemPrompt: string | undefined;
		let fallbackRequestToolNames: string[] | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start")
				stateBeforeFailedAssistant = structuredClone(harness.session.state.messages);
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			(context) => {
				fallbackRequestMessages = structuredClone(context.messages);
				stateAtFallbackRequest = structuredClone(harness.session.state.messages);
				fallbackRequestSystemPrompt = context.systemPrompt;
				fallbackRequestToolNames = (context.tools ?? []).map((tool) => tool.name);
				return fauxAssistantMessage("recovered");
			},
		]);

		await harness.session.prompt("second turn");

		if (!stateBeforeFailedAssistant) throw new Error("Missing pre-error fallback snapshot");
		expect(stateAtFallbackRequest).toEqual(stateBeforeFailedAssistant.slice(0, -1));
		expect(fallbackRequestMessages).toEqual(stateBeforeFailedAssistant.slice(0, -1));
		expect(modelSelectSources).toEqual(["faux-1->faux-2:fallback"]);
		expect(fallbackRequestSystemPrompt).toBe("fallback preset system prompt");
		expect(fallbackRequestToolNames).toEqual(["fallback_preset"]);
		expect(harness.session.systemPrompt).toBe("fallback preset system prompt");
		expect(harness.session.getActiveToolNames()).toEqual(["fallback_preset"]);
		expect(harness.session.getActiveToolNames()).not.toContain("primary_privileged");
	});

	it("invalidates an in-flight compaction when retry fallback changes the model", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: { retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seed")]);
		await harness.session.prompt("seed fallback compaction state");
		const firstEntry = harness.sessionManager.getEntries()[0];
		if (!firstEntry) throw new Error("Expected a persisted seed entry");
		const beginFeedback = Reflect.get(harness.session, "_beginExtensionCompactionFeedback");
		if (typeof beginFeedback !== "function") throw new Error("Expected extension compaction feedback lifecycle");
		const signal = beginFeedback.call(harness.session, "extension") as AbortSignal;
		let oldApply: Promise<unknown> | undefined;
		harness.session.subscribe((event) => {
			if (event.type !== "auto_retry_start" || event.delayMs !== 0) return;
			oldApply = harness.session.applyCompaction(
				{ summary: "must not apply after fallback selection", firstKeptEntryId: firstEntry.id, tokensBefore: 42 },
				{ reason: "extension", signal },
			);
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("fallback answer"),
		]);

		await harness.session.prompt("trigger fallback while compaction is pending");

		if (!oldApply) throw new Error("Expected fallback retry to attempt the stale apply");
		await expect(oldApply).resolves.toEqual({ applied: false, reason: "stale" });
		expect(signal.aborted).toBe(true);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it.each([
		["rejects", true],
		["accepts", false],
	])("revalidates the smaller fallback context window immediately before a retry (%s second compaction)", async (_label, rejectSecondCompaction) => {
		let compactionCount = 0;
		let releasePrimaryError: (() => void) | undefined;
		const primaryErrorReady = new Promise<void>((resolve) => {
			releasePrimaryError = resolve;
		});
		let primaryProviderStarted: (() => void) | undefined;
		const primaryStarted = new Promise<void>((resolve) => {
			primaryProviderStarted = resolve;
		});
		const fallbackCompactionEndsAtCall: number[] = [];
		const harness = await createHarness({
			models: [
				{ id: "faux-1", contextWindow: 1_000, maxTokens: 64 },
				{ id: "faux-2", contextWindow: 100, maxTokens: 64 },
			],
			settings: {
				compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 0 },
				retry: { enabled: true, baseDelayMs: 1, fallbackChains: { [primary]: [fallback] } },
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						compactionCount++;
						if (compactionCount === 2 && rejectSecondCompaction) {
							return {
								cancel: true,
								rejectionCause: "cancelled-by-extension" as const,
								reason: "fallback window requires a rejected second compaction",
							};
						}
						return {
							compaction: {
								summary: compactionCount === 1 ? "p".repeat(480) : "fallback summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		const primaryModel = harness.getModel("faux-1");
		if (!primaryModel) throw new Error("Expected primary fallback model");
		const historyTimestamp = Date.now() - 1_000;
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "history before retry fallback" }],
			timestamp: historyTimestamp,
		});
		harness.sessionManager.appendMessage({
			...fauxAssistantMessage("history response", { timestamp: historyTimestamp + 1 }),
			api: primaryModel.api,
			provider: primaryModel.provider,
			model: primaryModel.id,
			usage: {
				input: 900,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 900,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([
			async (_context, _options, _state, model) => {
				if (model.id === "faux-1") {
					primaryProviderStarted?.();
					await primaryErrorReady;
					return fauxAssistantMessage("context ".repeat(900), {
						stopReason: "error",
						errorMessage: "overloaded_error",
					});
				}
				fallbackCompactionEndsAtCall.push(
					harness.eventsOfType("compaction_end").filter((event) => event.accepted === true).length,
				);
				return fauxAssistantMessage("fallback answer");
			},
			(_context, _options, _state, model) => {
				fallbackCompactionEndsAtCall.push(
					harness.eventsOfType("compaction_end").filter((event) => event.accepted === true).length,
				);
				expect(model.id).toBe("faux-2");
				return fauxAssistantMessage("fallback answer");
			},
			fauxAssistantMessage("queued continuation answer"),
		]);

		const prompt = harness.session.prompt("trigger fallback window revalidation");
		await primaryStarted;
		if (rejectSecondCompaction) {
			await harness.session.followUp("queued until fallback context is safe");
		}
		releasePrimaryError?.();
		await prompt;

		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([{ from: primary, to: fallback }]);
		if (rejectSecondCompaction) {
			expect(fallbackCompactionEndsAtCall).toEqual([]);
			expect(harness.session.agent.hasQueuedMessages()).toBe(true);
			expect(harness.eventsOfType("compaction_start")).toHaveLength(2);
			expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({ accepted: false });
		} else {
			expect(fallbackCompactionEndsAtCall).toEqual([2]);
			expect(harness.eventsOfType("compaction_start")).toHaveLength(2);
			expect(harness.eventsOfType("compaction_end").filter((event) => event.accepted === true)).toHaveLength(2);
		}
	});

	it("submits a complete fallback request rather than reusing primary continuation state", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					baseDelayMs: 1,
					fallbackChains: { [primary]: [fallback] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "overloaded_error",
			}),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("full fallback request");

		const fallbackRequest = harness.faux.getCallLog()[1];
		if (!fallbackRequest) throw new Error("Missing fallback provider request");
		expect(fallbackRequest.modelId).toBe("faux-2");
		expect(fallbackRequest.context.messages).toEqual([
			expect.objectContaining({
				role: "user",
				content: [{ type: "text", text: "full fallback request" }],
			}),
		]);
		expect(fallbackRequest.context.messages).toHaveLength(1);
		expect(fallbackRequest.options).not.toHaveProperty("previous_response_id");
	});

	it("cancels a configured fallback retry before it can continue", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			settings: {
				retry: {
					enabled: true,
					baseDelayMs: 100,
					fallbackChains: { [primary]: [fallback] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "overloaded_error",
			}),
			fauxAssistantMessage("zombie fallback response"),
		]);
		let abortPromise: Promise<void> | undefined;
		const sawFallbackRetry = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "auto_retry_start" && event.delayMs === 0) {
					unsubscribe();
					abortPromise = harness.session.abort();
					resolve();
				}
			});
		});

		const promptPromise = harness.session.prompt("abort fallback retry");
		await sawFallbackRetry;
		if (!abortPromise) throw new Error("Fallback retry did not trigger abort");
		await abortPromise;
		await promptPromise;

		expect(harness.session.isIdle).toBe(true);
		expect(harness.session.isRetrying).toBe(false);
		expect(harness.session.retryAttempt).toBe(0);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.eventsOfType("auto_retry_end")).toMatchObject([{ success: false, finalError: "Retry cancelled" }]);
	});

	it("keeps the byte-for-byte no-chain retry event contract", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: true, baseDelayMs: 1 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "overloaded_error",
			}),
			fauxAssistantMessage("recovered"),
		]);

		await harness.session.prompt("hello");

		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(retryTranscript(harness.events)).toEqual([
			{ type: "agent_start" },
			{ type: "turn_start" },
			{ type: "message_start", role: "user" },
			{ type: "message_end", role: "user" },
			{ type: "message_start", role: "assistant" },
			{ type: "message_update", update: "text_start" },
			{ type: "message_update", update: "text_delta" },
			{ type: "message_update", update: "text_end" },
			{ type: "message_end", role: "assistant" },
			{ type: "turn_end" },
			{ type: "agent_end", willRetry: true },
			{
				type: "auto_retry_start",
				attempt: 1,
				maxAttempts: 3,
				delayMs: 1,
				errorMessage: "overloaded_error",
			},
			{ type: "agent_start" },
			{ type: "turn_start" },
			{ type: "message_start", role: "assistant" },
			{ type: "message_update", update: "text_start" },
			{ type: "message_update", update: "text_delta" },
			{ type: "message_update", update: "text_end" },
			{ type: "message_end", role: "assistant" },
			{ type: "auto_retry_end", success: true, attempt: 1 },
			{ type: "turn_end" },
			{ type: "agent_end", willRetry: false },
			{ type: "agent_settled" },
		]);
	});

	it("settles through the existing failure path when no fallback can be selected", async () => {
		const harness = await createHarness({
			settings: {
				retry: {
					enabled: true,
					maxRetries: 1,
					baseDelayMs: 1,
					fallbackChains: { [primary]: [] },
				},
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "overloaded_error",
			}),
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "overloaded_error",
			}),
		]);

		await harness.session.prompt("hello");

		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(harness.eventsOfType("auto_retry_end").map((event) => event.success)).toEqual([false]);
	});
});
