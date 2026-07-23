import type { AgentMessage, PrepareNextTurnContext } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	fauxAssistantMessage,
	fauxToolCall,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateContextTokens, estimateTokens, generateSummary } from "../../src/core/compaction/index.ts";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import { createHarness, type Harness } from "./harness.ts";

type CheckCompaction = (
	assistantMessage: AssistantMessage,
	skipAbortedCheck?: boolean,
	requestReason?: "pre_prompt",
) => Promise<void>;
type RunAutoCompaction = (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
interface BlockingBeforeCompactExtension {
	extension: (pi: ExtensionAPI) => void;
	releaseCancel(): void;
	started: Promise<AbortSignal>;
}

function getCheckCompaction(session: Harness["session"]): CheckCompaction {
	const value = Reflect.get(session, "_checkCompaction");
	if (typeof value !== "function") {
		throw new Error("AgentSession._checkCompaction is not available for characterization tests");
	}
	return value;
}

function getRunAutoCompaction(session: Harness["session"]): RunAutoCompaction {
	const value = Reflect.get(session, "_runAutoCompaction");
	if (typeof value !== "function") {
		throw new Error("AgentSession._runAutoCompaction is not available for characterization tests");
	}
	return value;
}

async function checkCompaction(
	session: Harness["session"],
	assistantMessage: AssistantMessage,
	skipAbortedCheck?: boolean,
	requestReason?: "pre_prompt",
): Promise<void> {
	await getCheckCompaction(session).call(session, assistantMessage, skipAbortedCheck, requestReason);
}

async function runAutoCompaction(
	session: Harness["session"],
	reason: "overflow" | "threshold",
	willRetry: boolean,
): Promise<void> {
	await getRunAutoCompaction(session).call(session, reason, willRetry);
}

function stubRunAutoCompaction(session: Harness["session"]) {
	const stub = vi.fn(async (_reason: "overflow" | "threshold", _willRetry: boolean): Promise<void> => {});
	Reflect.set(session, "_runAutoCompaction", stub);
	return stub;
}

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

function bypassFirstPrePromptCompaction(harness: Harness): void {
	const original = Reflect.get(harness.session, "_enforceCompactionBeforeProvider");
	if (typeof original !== "function") {
		throw new Error("AgentSession._enforceCompactionBeforeProvider is not available for retry characterization");
	}
	let bypassed = false;
	Reflect.set(harness.session, "_enforceCompactionBeforeProvider", async (...args: unknown[]) => {
		if (!bypassed) {
			bypassed = true;
			return false;
		}
		return await original.apply(harness.session, args);
	});
}

function seedSuccessfulContextAboveThreshold(harness: Harness): void {
	const model = harness.getModel();
	const timestamp = Date.now() - 1_000;
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "successful context seed" }],
		timestamp: timestamp - 1,
	});
	harness.sessionManager.appendMessage(
		createAssistant(harness, {
			text: "successful response before retryable failure",
			stopReason: "stop",
			totalTokens: (model.contextWindow ?? 10_000) - 999,
			timestamp,
		}),
	);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function createAssistant(
	harness: Harness,
	options: {
		text?: string;
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		totalTokens?: number;
		timestamp?: number;
	},
): AssistantMessage {
	const model = harness.getModel();
	return {
		...fauxAssistantMessage(options.text ?? "", {
			stopReason: options.stopReason,
			errorMessage: options.errorMessage,
			timestamp: options.timestamp,
		}),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: createUsage(options.totalTokens ?? 0),
	};
}

function useSummaryStreamFn(harness: Harness, summary: string): () => number {
	let callCount = 0;
	harness.session.agent.streamFn = (model) => {
		callCount++;
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			const message: AssistantMessage = {
				...fauxAssistantMessage(summary),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createUsage(10),
			};
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	return () => callCount;
}

function createBlockingBeforeCompactExtension(): BlockingBeforeCompactExtension {
	let release: ((value: { cancel: true }) => void) | undefined;
	let resolveStarted: ((signal: AbortSignal) => void) | undefined;
	const started = new Promise<AbortSignal>((resolve) => {
		resolveStarted = resolve;
	});
	return {
		started,
		releaseCancel() {
			release?.({ cancel: true });
		},
		extension(pi) {
			pi.on("session_before_compact", async (event) => {
				return await new Promise<{ cancel: true }>((resolve) => {
					release = resolve;
					resolveStarted?.(event.signal);
					event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
				});
			});
		},
	};
}

function seedCompactableSession(harness: Harness): void {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	harness.sessionManager.appendMessage(
		Object.assign(
			createAssistant(harness, {
				stopReason: "stop",
				totalTokens: 100,
				timestamp: now - 500,
			}),
			{ content: [{ type: "text" as const, text: "assistant response to compact" }] },
		),
	);
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to keep" }],
		timestamp: now,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function createResultToolExtension(toolResult: string, compactionSummary?: string, terminate = false) {
	return (pi: ExtensionAPI): void => {
		pi.registerTool({
			name: "large_result",
			label: "Large Result",
			description: "Return text for next-turn compaction tests",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: toolResult }],
				details: {},
				terminate,
			}),
		});
		if (compactionSummary !== undefined) {
			pi.on("session_before_compact", async (event) => ({
				compaction: {
					summary: compactionSummary,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: {},
				},
			}));
		}
	};
}

async function prepareTerminatingOverLimitPrompt(
	harness: Harness,
	contextWindow: number,
	reserveTokens: number,
): Promise<void> {
	const seedTimestamp = Date.now() - 2_000;
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "prior separate prompt context ".repeat(220) }],
		timestamp: seedTimestamp,
	});
	harness.sessionManager.appendMessage(
		createAssistant(harness, {
			text: "prior response",
			stopReason: "stop",
			totalTokens: 700,
			timestamp: seedTimestamp + 1_000,
		}),
	);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	harness.setResponses([
		Object.assign(createAssistant(harness, { stopReason: "toolUse", totalTokens: 700 }), {
			content: [fauxToolCall("large_result", {})],
		}),
		() => {
			throw new Error("provider call 2 must not be reached");
		},
	]);
	await harness.session.prompt("run the terminating result tool");
	expect(estimateContextTokens(harness.sessionManager.buildSessionContext().messages).tokens).toBeGreaterThan(
		contextWindow - reserveTokens,
	);
}

describe("AgentSession compaction characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("manually compacts using an extension-provided summary", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "summary from extension",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: { source: "extension" },
						},
					}));
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const result = await harness.session.compact();
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const estimatedTokensAfter = harness.session.messages.reduce((sum, message) => sum + estimateTokens(message), 0);

		expect(result.summary).toBe("summary from extension");
		expect(result.estimatedTokensAfter).toBe(estimatedTokensAfter);
		expect(compactionEntries).toHaveLength(1);
		expect(harness.session.messages[0]?.role).toBe("compactionSummary");
	});

	it("throws when compacting without a model", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		Reflect.set(harness.session.agent.state, "model", undefined);

		await expect(harness.session.compact()).rejects.toThrow("No model selected");
	});

	it("throws when manually compacting a session that fits within keepRecentTokens", async () => {
		// given
		const harness = await createHarness();
		harnesses.push(harness);

		await harness.session.prompt("hi");
		await harness.session.prompt("who are you");

		// when / then
		await expect(harness.session.compact()).rejects.toThrow("Nothing to compact (session too small)");
		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(compactionEntries).toHaveLength(0);
	});

	it("throws when compacting without configured auth", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			withConfiguredAuth: false,
		});
		harnesses.push(harness);

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "first user" }],
			timestamp: Date.now() - 2000,
		});
		harness.sessionManager.appendMessage(createAssistant(harness, { text: "first assistant", totalTokens: 100 }));
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "second user" }],
			timestamp: Date.now(),
		});

		await expect(harness.session.compact()).rejects.toThrow(`No API key found for ${harness.getModel().provider}.`);
	});

	it("manually compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			withConfiguredAuth: false,
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "summary from custom stream");

		const result = await harness.session.compact();

		expect(result.summary).toContain("summary from custom stream");
		expect(getStreamCallCount()).toBe(1);
	});

	it("auto-compacts with a custom streamFn when registry auth is absent", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			withConfiguredAuth: false,
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const getStreamCallCount = useSummaryStreamFn(harness, "auto summary from custom stream");

		await runAutoCompaction(harness.session, "threshold", false);

		const compactionEntries = harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEntries).toHaveLength(1);
		expect(compactionEnd?.result?.estimatedTokensAfter).toBeGreaterThan(0);
		expect(getStreamCallCount()).toBe(1);
	});

	it("does not emit compaction events for a normal response below the threshold", async () => {
		// given
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("plain response")]);

		// when
		await harness.session.prompt("hello");

		// then
		expect(harness.session.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(0);
	});

	it("compacts trailing tool results before provider call 2 when they push context over the threshold", async () => {
		// given
		const contextWindow = 5_000;
		const reserveTokens = 1_000;
		const threshold = contextWindow - reserveTokens;
		const largeToolResult = "tool output ".repeat(300);
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens } },
			models: [{ id: "faux-1", contextWindow }],
			extensionFactories: [createResultToolExtension(largeToolResult, "tool result threshold summary")],
		});
		harnesses.push(harness);
		const seedTimestamp = Date.now() - 2_000;
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "prior context ".repeat(220) }],
			timestamp: seedTimestamp,
		});
		harness.sessionManager.appendMessage(
			createAssistant(harness, {
				text: "prior response",
				stopReason: "stop",
				totalTokens: 700,
				timestamp: seedTimestamp + 1_000,
			}),
		);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		let call2Context = "";
		let compactionEndsAtCall2 = 0;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			(context) => {
				call2Context = JSON.stringify(context.messages);
				compactionEndsAtCall2 = harness.eventsOfType("compaction_end").length;
				return fauxAssistantMessage("done after compaction");
			},
		]);

		// when
		await harness.session.prompt("run the large result tool");

		// then
		const persistedMessages = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "message")
			.map((entry) => entry.message);
		const toolCallResponse = persistedMessages.find(
			(message) => message.role === "assistant" && message.stopReason === "toolUse",
		);
		const toolResult = persistedMessages.find((message) => message.role === "toolResult");
		if (toolCallResponse?.role !== "assistant" || toolResult?.role !== "toolResult") {
			throw new Error("Expected a successful assistant tool call and its appended tool result");
		}
		const assembledContext = estimateContextTokens([toolCallResponse, toolResult]);
		expect(toolCallResponse.usage.totalTokens).toBeLessThan(threshold);
		expect(assembledContext.tokens).toBeGreaterThan(threshold);
		expect(compactionEndsAtCall2).toBe(1);
		expect(call2Context).toContain("tool result threshold summary");
		expect(call2Context).toContain(largeToolResult);
		expect(call2Context).not.toContain("prior context ");
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["threshold"]);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")[0]).toMatchObject({
			reason: "threshold",
			aborted: false,
			willRetry: false,
			accepted: true,
		});
	});

	it("compacts a terminating tool result before the next separate user prompt", async () => {
		// given
		const contextWindow = 5_000;
		const reserveTokens = 1_000;
		const threshold = contextWindow - reserveTokens;
		const largeToolResult = "terminating tool output ".repeat(300);
		const compactionSummary = "terminating tool result summary";
		let call2Context = "";
		let compactionEndsAtCall2 = 0;
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens } },
			models: [{ id: "faux-1", contextWindow }],
			extensionFactories: [createResultToolExtension(largeToolResult, compactionSummary, true)],
		});
		harnesses.push(harness);
		const seedTimestamp = Date.now() - 2_000;
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "prior terminating context ".repeat(220) }],
			timestamp: seedTimestamp,
		});
		harness.sessionManager.appendMessage(
			createAssistant(harness, {
				text: "prior response",
				stopReason: "stop",
				totalTokens: 700,
				timestamp: seedTimestamp + 1_000,
			}),
		);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const terminatingToolCall = Object.assign(createAssistant(harness, { stopReason: "toolUse", totalTokens: 700 }), {
			content: [fauxToolCall("large_result", {})],
		});
		harness.setResponses([
			terminatingToolCall,
			(context) => {
				call2Context = JSON.stringify(context.messages);
				compactionEndsAtCall2 = harness.eventsOfType("compaction_end").length;
				return createAssistant(harness, {
					text: "done after pre-prompt compaction",
					stopReason: "stop",
					totalTokens: 1_000,
				});
			},
		]);

		await harness.session.prompt("run the terminating result tool");
		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		if (toolResult?.role !== "toolResult") {
			throw new Error("Expected the terminating tool result in the persisted session context");
		}
		const persistedContext = estimateContextTokens(harness.sessionManager.buildSessionContext().messages);
		expect(terminatingToolCall.usage.totalTokens).toBeLessThan(threshold);
		expect(persistedContext.tokens).toBeGreaterThan(threshold);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["threshold"]);

		// when
		await harness.session.prompt("continue after the terminating tool");

		// then
		expect(compactionEndsAtCall2).toBe(1);
		expect(call2Context).toContain(compactionSummary);
		expect(call2Context).toContain(largeToolResult);
		expect(call2Context).not.toContain("prior terminating context ");
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("stops before a separate prompt provider call when required pre-prompt compaction is cancelled", async () => {
		// given
		const contextWindow = 5_000;
		const reserveTokens = 1_000;
		const largeToolResult = "terminating oversized output ".repeat(350);
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens } },
			models: [{ id: "faux-1", contextWindow }],
			extensionFactories: [
				createResultToolExtension(largeToolResult, undefined, true),
				(pi) => {
					pi.on("session_before_compact", async () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		await prepareTerminatingOverLimitPrompt(harness, contextWindow, reserveTokens);

		// when / then
		await expect(harness.session.prompt("continue after cancelled compaction")).rejects.toThrow(
			"Context remains above the compaction threshold because compaction did not complete",
		);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end")).toContainEqual(
			expect.objectContaining({ reason: "pre_prompt", accepted: false, rejectionCause: "cancelled-by-extension" }),
		);
	});

	it("stops before a separate prompt provider call when required pre-prompt compaction would remain oversized", async () => {
		// given
		const contextWindow = 5_000;
		const reserveTokens = 1_000;
		const largeToolResult = "terminating oversized output ".repeat(350);
		const oversizedSummary = "irreducibly oversized summary ".repeat(2_000);
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens } },
			models: [{ id: "faux-1", contextWindow }],
			extensionFactories: [createResultToolExtension(largeToolResult, oversizedSummary, true)],
		});
		harnesses.push(harness);
		await prepareTerminatingOverLimitPrompt(harness, contextWindow, reserveTokens);

		// when / then
		await expect(harness.session.prompt("continue after oversized compaction")).rejects.toThrow(
			"Context remains above the compaction threshold because compaction did not complete",
		);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end")).toContainEqual(
			expect.objectContaining({ reason: "pre_prompt", accepted: false, rejectionCause: "would-overflow" }),
		);
	});

	it("preserves a constructor-supplied next-turn callback after rebuilding compacted context", async () => {
		// given
		const largeToolResult = "callback tool output ".repeat(300);
		const compactionSummary = "callback-preserved summary";
		const callbackContexts: string[] = [];
		const prepareNextTurnWithContext = vi.fn(async (turn) => {
			callbackContexts.push(JSON.stringify(turn.context.messages));
			return undefined;
		});
		const harness = await createHarness({
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1_000 },
				retry: { enabled: false },
			},
			models: [{ id: "faux-1", contextWindow: 5_000 }],
			extensionFactories: [createResultToolExtension(largeToolResult, compactionSummary)],
			prepareNextTurnWithContext,
		});
		harnesses.push(harness);
		const seedTimestamp = Date.now() - 2_000;
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "callback prior context ".repeat(220) }],
			timestamp: seedTimestamp,
		});
		harness.sessionManager.appendMessage(
			createAssistant(harness, {
				text: "prior response",
				stopReason: "stop",
				totalTokens: 700,
				timestamp: seedTimestamp + 1_000,
			}),
		);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done after callback", { stopReason: "error", errorMessage: "test complete" }),
		]);

		// when
		await harness.session.prompt("run the callback result tool");

		// then
		expect(prepareNextTurnWithContext).toHaveBeenCalledTimes(1);
		expect(callbackContexts[0]).toContain(compactionSummary);
		expect(callbackContexts[0]).toContain(largeToolResult);
		expect(callbackContexts[0]).not.toContain("callback prior context ");
	});

	it("retains a constructor next-turn context transform in the provider request after compaction", async () => {
		const largeToolResult = "transformed callback tool output ".repeat(300);
		const compactionSummary = "transform-before-next-turn summary";
		const injectedMarker = "INJECTED_NEXT_TURN_CONTEXT";
		const callbackInputs: string[] = [];
		let continuationRequest = "";
		const prepareNextTurnWithContext = vi.fn(async (turn: PrepareNextTurnContext) => {
			callbackInputs.push(JSON.stringify(turn.context.messages));
			return {
				context: {
					...turn.context,
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: injectedMarker }],
							timestamp: Date.now(),
						},
						...turn.context.messages.filter((message) => message.role !== "compactionSummary").reverse(),
					],
				},
			};
		});
		const harness = await createHarness({
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1_000 },
				retry: { enabled: false },
			},
			models: [{ id: "faux-1", contextWindow: 5_000 }],
			extensionFactories: [createResultToolExtension(largeToolResult, compactionSummary)],
			prepareNextTurnWithContext,
		});
		harnesses.push(harness);
		const timestamp = Date.now() - 2_000;
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "transform prior context ".repeat(220) }],
			timestamp,
		});
		harness.sessionManager.appendMessage(
			createAssistant(harness, {
				text: "prior response",
				stopReason: "stop",
				totalTokens: 700,
				timestamp: timestamp + 1_000,
			}),
		);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			(context) => {
				continuationRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("done after transformed callback");
			},
		]);

		await harness.session.prompt("run the transformed callback result tool");

		expect(prepareNextTurnWithContext).toHaveBeenCalled();
		expect(callbackInputs).toContainEqual(expect.stringContaining(compactionSummary));
		expect(continuationRequest).toContain(injectedMarker);
		expect(continuationRequest).not.toContain(compactionSummary);
		expect(continuationRequest.indexOf(injectedMarker)).toBeLessThan(continuationRequest.indexOf(largeToolResult));
	});

	it("reapplies a late constructor next-turn transform to the post-compaction provider request", async () => {
		// given a constructor callback that suspends mid-turn and transforms the
		// context (inject + redact + reorder), and a queue that arrives while the
		// callback is suspended so the second admission sample compacts.
		const callbackStarted = createDeferred();
		const releaseCallback = createDeferred();
		const injectedMarker = "INJECTED_LATE_CALLBACK_CONTEXT";
		const compactionSummary = "late callback compaction summary";
		const queuedText = "queued while the next-turn callback is suspended";
		let continuationRequest = "";
		const prepareNextTurnWithContext = vi.fn(async (turn: PrepareNextTurnContext) => {
			callbackStarted.resolve();
			await releaseCallback.promise;
			return {
				context: {
					...turn.context,
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: injectedMarker }],
							timestamp: Date.now(),
						},
						...turn.context.messages.filter((message) => message.role !== "compactionSummary").reverse(),
					],
				},
			};
		});
		const harness = await createHarness({
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1_000 },
				retry: { enabled: false },
			},
			models: [{ id: "faux-1", contextWindow: 5_000 }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: compactionSummary,
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
			prepareNextTurnWithContext,
		});
		harnesses.push(harness);
		const seedTimestamp = Date.now() - 2_000;
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "late callback prior context ".repeat(220) }],
			timestamp: seedTimestamp,
		});
		harness.sessionManager.appendMessage(
			createAssistant(harness, {
				text: "prior response",
				stopReason: "stop",
				totalTokens: 700,
				timestamp: seedTimestamp + 1_000,
			}),
		);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		const model = harness.getModel();
		harness.setResponses([
			{
				...fauxAssistantMessage("first response before the queued admission"),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: createUsage(4_500),
			},
			(context) => {
				continuationRequest = JSON.stringify(context.messages);
				return fauxAssistantMessage("response after the queued admission");
			},
		]);

		// when the first turn completes, the callback suspends, a queue arrives, and
		// the second admission sample compacts before the continuation request.
		const promptPromise = harness.session.prompt("trigger the late next-turn callback");
		void promptPromise.catch(() => undefined);
		await callbackStarted.promise;
		await harness.session.steer(queuedText);
		releaseCallback.resolve();
		await promptPromise;

		// then the queued admission did compact exactly once, and the provider
		// request for the drained queue still respects the host transformation
		// (reapplied on the post-compaction context), not the raw compacted state.
		expect(prepareNextTurnWithContext).toHaveBeenCalled();
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(continuationRequest).toContain(injectedMarker);
		expect(continuationRequest).not.toContain(compactionSummary);
		expect(continuationRequest.indexOf(injectedMarker)).toBeGreaterThanOrEqual(0);
		expect(continuationRequest.indexOf(injectedMarker)).toBeLessThan(continuationRequest.indexOf(queuedText));
	});

	it("applies the provider context transform to inline compaction summarization", async () => {
		// given
		const sensitiveToolOutput = "SENSITIVE_TOOL_OUTPUT";
		const permittedToolOutput = "PERMITTED_TOOL_OUTPUT";
		const contextWindow = 5_000;
		const reserveTokens = 1_000;
		const largeToolResult = "tool output ".repeat(300);
		const priorToolResult = `${sensitiveToolOutput}\n${permittedToolOutput}`;
		const priorToolCall = fauxToolCall("prior_tool", {});
		const compactionSummary = "provider-generated callback summary";
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens } },
			models: [{ id: "faux-1", contextWindow }],
			extensionFactories: [
				createResultToolExtension(largeToolResult),
				(pi) => {
					pi.on("context", async (event) => ({
						messages: event.messages.map((message) => {
							if (message.role !== "toolResult") return message;
							return {
								...message,
								content: message.content.map((content) =>
									content.type === "text"
										? { ...content, text: content.text.replaceAll(sensitiveToolOutput, "") }
										: content,
								),
							};
						}),
					}));
				},
			],
		});
		harnesses.push(harness);
		const seedTimestamp = Date.now() - 2_000;
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "prior context ".repeat(220) }],
			timestamp: seedTimestamp,
		});
		harness.sessionManager.appendMessage(
			Object.assign(
				createAssistant(harness, {
					stopReason: "toolUse",
					totalTokens: 700,
					timestamp: seedTimestamp + 500,
				}),
				{ content: [priorToolCall] },
			),
		);
		harness.sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: priorToolCall.id,
			toolName: "prior_tool",
			content: [{ type: "text", text: priorToolResult }],
			details: {},
			isError: false,
			timestamp: seedTimestamp + 1_000,
		});
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(compactionSummary),
			fauxAssistantMessage("provider-generated turn prefix summary"),
			fauxAssistantMessage("done after callback-filtered compaction"),
		]);

		// when
		await harness.session.prompt("run the sensitive result tool");

		// then
		const callLog = harness.faux.getCallLog();
		const historyCompactionContext = JSON.stringify(callLog[1]?.context.messages ?? []);
		const turnPrefixCompactionContext = JSON.stringify(callLog[2]?.context.messages ?? []);
		const continuationProviderContext = JSON.stringify(callLog[3]?.context.messages ?? []);
		expect(historyCompactionContext).toContain(permittedToolOutput);
		expect(historyCompactionContext).not.toContain(sensitiveToolOutput);
		expect(turnPrefixCompactionContext).not.toContain(sensitiveToolOutput);
		expect(continuationProviderContext).toContain(compactionSummary);
		expect(continuationProviderContext).not.toContain(sensitiveToolOutput);
		expect(harness.faux.state.callCount).toBe(4);
		expect(harness.eventsOfType("compaction_end")).toContainEqual(
			expect.objectContaining({ reason: "threshold", accepted: true }),
		);
	});

	it("applies the provider context transform to a persisted previous summary", async () => {
		// given
		const sensitiveSummary = "SENSITIVE_PREVIOUS_SUMMARY";
		const injectedDirective = "INJECTED_SAFETY_DIRECTIVE";
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("updated summary")]);
		const transformContext = vi.fn(async (messages: AgentMessage[]) => [
			...messages.map((message) => {
				if (message.role !== "user" || typeof message.content === "string") return message;
				return {
					...message,
					content: message.content.map((content) =>
						content.type === "text"
							? { ...content, text: content.text.replaceAll(sensitiveSummary, "") }
							: content,
					),
				};
			}),
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: injectedDirective }],
				timestamp: Date.now(),
			},
		]);

		// when
		await generateSummary(
			[
				{
					role: "user",
					content: [{ type: "text", text: "new conversation content" }],
					timestamp: Date.now(),
				},
			],
			harness.getModel(),
			1_000,
			"faux-key",
			undefined,
			undefined,
			undefined,
			sensitiveSummary,
			undefined,
			undefined,
			undefined,
			undefined,
			transformContext,
		);

		// then
		const providerContext = JSON.stringify(harness.faux.getCallLog()[0]?.context.messages ?? []);
		expect(transformContext).toHaveBeenCalledTimes(1);
		expect(providerContext).not.toContain(sensitiveSummary);
		expect(providerContext).toContain("new conversation content");
		expect(providerContext.split(injectedDirective)).toHaveLength(2);
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("stops before provider call 2 when required inline threshold compaction is cancelled", async () => {
		// given
		const contextWindow = 5_000;
		const reserveTokens = 1_000;
		const largeToolResult = "tool output ".repeat(300);
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens } },
			models: [{ id: "faux-1", contextWindow }],
			extensionFactories: [
				createResultToolExtension(largeToolResult),
				(pi) => {
					pi.on("session_before_compact", async () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		const seedTimestamp = Date.now() - 2_000;
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "prior context ".repeat(220) }],
			timestamp: seedTimestamp,
		});
		harness.sessionManager.appendMessage(
			createAssistant(harness, {
				text: "prior response",
				stopReason: "stop",
				totalTokens: 700,
				timestamp: seedTimestamp + 1_000,
			}),
		);
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" })]);

		// when
		await harness.session.prompt("run the large result tool");

		// then
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.agent.state.errorMessage).toContain(
			"Context remains above the compaction threshold because compaction did not complete",
		);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end")).toContainEqual(
			expect.objectContaining({
				reason: "threshold",
				accepted: false,
				rejectionCause: "cancelled-by-extension",
			}),
		);
	});

	it("continues to provider call 2 without compaction when trailing tool results stay below the threshold", async () => {
		// given
		const harness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1_000 } },
			models: [{ id: "faux-1", contextWindow: 5_000 }],
			extensionFactories: [createResultToolExtension("small tool output")],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done without compaction"),
		]);

		// when
		await harness.session.prompt("run the small result tool");

		// then
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(0);
	});

	it("continues to provider call 2 without compaction when compaction is disabled", async () => {
		// given
		const contextWindow = 5_000;
		const reserveTokens = 1_000;
		const threshold = contextWindow - reserveTokens;
		const largeToolResult = "tool output ".repeat(2_000);
		const harness = await createHarness({
			settings: { compaction: { enabled: false, reserveTokens } },
			models: [{ id: "faux-1", contextWindow }],
			extensionFactories: [createResultToolExtension(largeToolResult)],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("large_result", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done with compaction disabled"),
		]);

		// when
		await harness.session.prompt("run the large result tool");

		// then
		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		if (toolResult?.role !== "toolResult") {
			throw new Error("Expected the large tool result in the session context");
		}
		expect(estimateTokens(toolResult)).toBeGreaterThan(threshold);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(0);
	});

	it("cancels in-progress manual compaction when abortCompaction is called", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
						});
					});
				},
			],
		});
		harnesses.push(harness);

		await harness.session.prompt("one");
		await harness.session.prompt("two");

		const compactPromise = harness.session.compact();
		await new Promise((resolve) => setTimeout(resolve, 0));
		harness.session.abortCompaction();

		await expect(compactPromise).rejects.toThrow("Compaction cancelled");
	});

	it("cancels in-progress manual compaction when the session is aborted", async () => {
		// given
		const blocker = createBlockingBeforeCompactExtension();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [blocker.extension],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		const compactPromise = harness.session.compact();
		const signal = await blocker.started;

		// when
		await harness.session.abort();
		const signalWasAborted = signal.aborted;
		blocker.releaseCancel();

		// then
		await expect(compactPromise).rejects.toThrow("Compaction cancelled");
		expect(signalWasAborted).toBe(true);
	});

	it("cancels in-progress manual compaction when switching to a larger-context model", async () => {
		// given
		const blocker = createBlockingBeforeCompactExtension();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			models: [
				{ id: "small", contextWindow: 32_000 },
				{ id: "large", contextWindow: 800_000 },
			],
			extensionFactories: [blocker.extension],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		const largeModel = harness.getModel("large");
		if (!largeModel) {
			throw new Error("Expected large model");
		}

		const compactPromise = harness.session.compact();
		const signal = await blocker.started;

		// when
		await harness.session.setModel(largeModel);
		const signalWasAborted = signal.aborted;
		blocker.releaseCancel();

		// then
		await expect(compactPromise).rejects.toThrow("Compaction cancelled");
		expect(signalWasAborted).toBe(true);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("resumes after threshold compaction when only agent-level queued messages exist", async () => {
		vi.useFakeTimers();
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await harness.session.prompt("first");
		await harness.session.prompt("second");

		harness.session.agent.followUp({
			role: "custom",
			customType: "test",
			content: [{ type: "text", text: "queued custom" }],
			display: false,
			timestamp: Date.now(),
		});

		const continueSpy = vi.spyOn(harness.session.agent, "continue").mockResolvedValue();

		await runAutoCompaction(harness.session, "threshold", false);
		await vi.advanceTimersByTimeAsync(100);

		expect(continueSpy).toHaveBeenCalledTimes(1);
	});

	it("compacts a retryable zero-usage error before retrying when the prior context is above threshold", async () => {
		let acceptedCompactionsAtRetryProviderCall = 0;
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 1_000 }],
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1_000 },
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "retry threshold summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedSuccessfulContextAboveThreshold(harness);
		bypassFirstPrePromptCompaction(harness);
		harness.setResponses([
			createAssistant(harness, { stopReason: "error", errorMessage: "overloaded_error", totalTokens: 0 }),
			() => {
				acceptedCompactionsAtRetryProviderCall = harness
					.eventsOfType("compaction_end")
					.filter((event) => event.reason === "threshold" && event.accepted).length;
				return fauxAssistantMessage("retry succeeded after compaction");
			},
		]);

		await harness.session.prompt("trigger zero-usage retryable failure");

		expect(harness.faux.state.callCount).toBe(2);
		expect(acceptedCompactionsAtRetryProviderCall).toBe(1);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("retains queues and skips the retry provider call when required retry compaction is rejected", async () => {
		const providerStarted = createDeferred();
		const releaseError = createDeferred();
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 10_000, maxTokens: 1_000 }],
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1_000 },
				retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async () => ({
						cancel: true,
						rejectionCause: "cancelled-by-extension",
						reason: "retry compaction rejected",
					}));
				},
			],
		});
		harnesses.push(harness);
		seedSuccessfulContextAboveThreshold(harness);
		bypassFirstPrePromptCompaction(harness);
		harness.setResponses([
			async () => {
				providerStarted.resolve();
				await releaseError.promise;
				return createAssistant(harness, {
					stopReason: "error",
					errorMessage: "overloaded_error",
					totalTokens: 0,
				});
			},
			fauxAssistantMessage("retry provider must not run"),
		]);

		const prompt = harness.session.prompt("trigger rejected retry compaction");
		await providerStarted.promise;
		await harness.session.followUp("retain retry follow-up");
		releaseError.resolve();
		await prompt;

		expect(harness.eventsOfType("compaction_end")).toContainEqual(
			expect.objectContaining({
				reason: "threshold",
				accepted: false,
				rejectionCause: "cancelled-by-extension",
			}),
		);
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.getFollowUpMessages()).toEqual(["retain retry follow-up"]);
		expect(harness.session.agent.hasQueuedMessages()).toBe(true);
	});

	it("does not retry overflow recovery more than once", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const overflowMessage = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		const runAutoCompactionSpy = stubRunAutoCompaction(harness.session);
		const compactionErrors: string[] = [];
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.errorMessage) {
				compactionErrors.push(event.errorMessage);
			}
		});

		await checkCompaction(harness.session, overflowMessage);
		await checkCompaction(harness.session, { ...overflowMessage, timestamp: Date.now() + 1 });

		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
		expect(compactionErrors).toContain(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
	});

	it("blocks pre-prompt continuation after overflow recovery already failed", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const firstOverflow = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		const secondOverflow = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now() + 1,
		});
		const userMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "continue" }],
			timestamp: Date.now() - 1,
		};
		const runAutoCompactionSpy = stubRunAutoCompaction(harness.session);

		//#given - overflow recovery already used its compact-and-retry attempt
		await checkCompaction(harness.session, firstOverflow);
		harness.session.agent.state.messages = [userMessage, secondOverflow];

		//#when - a continuation tries to start another turn while the latest assistant is still overflowed
		const prompt = harness.session.prompt("continue goal");

		//#then - the prompt is blocked before another doomed provider request can be sent
		await expect(prompt).rejects.toThrow(
			"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
		);
		expect(runAutoCompactionSpy).toHaveBeenCalledTimes(1);
	});

	it("does not consume the overflow compact-and-retry attempt when compaction fails before retrying", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const firstOverflow = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now(),
		});
		const secondOverflow = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "prompt is too long",
			timestamp: Date.now() + 1,
		});
		const userMessage = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "continue" }],
			timestamp: Date.now() - 1,
		};

		harness.session.agent.state.messages = [userMessage, firstOverflow];
		await checkCompaction(harness.session, firstOverflow);
		harness.session.agent.state.messages = [userMessage, secondOverflow];
		await checkCompaction(harness.session, secondOverflow);

		const overflowStarts = harness.eventsOfType("compaction_start").filter((event) => event.reason === "overflow");
		const terminalOverflowFailures = harness
			.eventsOfType("compaction_end")
			.filter((event) =>
				event.errorMessage?.startsWith("Context overflow recovery failed after one compact-and-retry attempt"),
			);
		expect(overflowStarts).toHaveLength(2);
		expect(terminalOverflowFailures).toHaveLength(0);
	});

	it("auto-retries overflow recovery when a provider alias differs but current context is still near the limit", async () => {
		const harness = await createHarness({
			api: "openai-codex-responses",
			provider: "openai-codex",
			models: [
				{
					id: "gpt-5.5",
					contextWindow: 272_000,
				},
			],
			settings: { compaction: { enabled: true, reserveTokens: 16_384 } },
		});
		harnesses.push(harness);
		const successfulAssistant = {
			...createAssistant(harness, {
				stopReason: "stop",
				totalTokens: 260_000,
				timestamp: Date.now() - 1_000,
			}),
			provider: "openai",
			model: "gpt-5.5",
		};
		const overflowMessage = {
			...createAssistant(harness, {
				stopReason: "error",
				errorMessage:
					"Your input exceeds the context window of this model. Please adjust your input and try again.",
				timestamp: Date.now(),
			}),
			provider: "openai",
			model: "gpt-5.5",
		};
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "initial work" }], timestamp: Date.now() - 2_000 },
			successfulAssistant,
			{ role: "user", content: [{ type: "text", text: "continue" }], timestamp: Date.now() - 500 },
			overflowMessage,
		];

		const runAutoCompactionSpy = stubRunAutoCompaction(harness.session);

		await checkCompaction(harness.session, overflowMessage);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("overflow", true);
	});

	it("compacts successful overflow responses without retrying", async () => {
		const harness = await createHarness({
			settings: { compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 0 } },
			models: [{ id: "faux-1", contextWindow: 1, maxTokens: 100 }],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "successful overflow compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("completed answer")]);

		await expect(harness.session.prompt("hello")).resolves.toBeUndefined();

		const compactionEnd = harness.eventsOfType("compaction_end").at(-1);
		expect(compactionEnd).toMatchObject({
			reason: "overflow",
			aborted: false,
			willRetry: false,
		});
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("ignores stale pre-compaction assistant usage on pre-prompt checks", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const staleTimestamp = Date.now() - 10_000;
		const staleAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 610_000,
			timestamp: staleTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: staleTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(staleAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			staleAssistant.usage.totalTokens,
			undefined,
			false,
		);
		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "after compaction" }],
			timestamp: Date.now(),
		});

		const runAutoCompactionSpy = stubRunAutoCompaction(harness.session);

		await checkCompaction(harness.session, staleAssistant, false);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("triggers threshold compaction for error messages using the last successful usage", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const successfulAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: Date.now(),
		});
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now() + 1000,
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			successfulAssistant,
			{ role: "user", content: [{ type: "text", text: "retry" }], timestamp: Date.now() + 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = stubRunAutoCompaction(harness.session);

		await checkCompaction(harness.session, errorAssistant);

		expect(runAutoCompactionSpy).toHaveBeenCalledWith("threshold", false);
	});

	it("does not trigger threshold compaction for error messages when no prior usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }], timestamp: Date.now() - 1000 },
			errorAssistant,
		];

		const runAutoCompactionSpy = stubRunAutoCompaction(harness.session);

		await checkCompaction(harness.session, errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction when only kept pre-compaction usage exists", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const preCompactionTimestamp = Date.now() - 10_000;
		const keptAssistant = createAssistant(harness, {
			stopReason: "stop",
			totalTokens: 190_000,
			timestamp: preCompactionTimestamp,
		});

		harness.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "before compaction" }],
			timestamp: preCompactionTimestamp - 1000,
		});
		harness.sessionManager.appendMessage(keptAssistant);
		const firstKeptEntryId = harness.sessionManager.getEntries()[0]!.id;
		harness.sessionManager.appendCompaction(
			"summary",
			firstKeptEntryId,
			keptAssistant.usage.totalTokens,
			undefined,
			false,
		);

		const errorAssistant = createAssistant(harness, {
			stopReason: "error",
			errorMessage: "529 overloaded",
			timestamp: Date.now(),
		});
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "kept user" }], timestamp: preCompactionTimestamp - 1000 },
			keptAssistant,
			{ role: "user", content: [{ type: "text", text: "new prompt" }], timestamp: Date.now() - 500 },
			errorAssistant,
		];

		const runAutoCompactionSpy = stubRunAutoCompaction(harness.session);

		await checkCompaction(harness.session, errorAssistant);

		expect(runAutoCompactionSpy).not.toHaveBeenCalled();
	});

	it("does not trigger threshold compaction below the threshold or when disabled", async () => {
		const belowThresholdHarness = await createHarness({
			settings: { compaction: { enabled: true, reserveTokens: 1000 } },
			models: [{ id: "faux-1", contextWindow: 200_000 }],
		});
		harnesses.push(belowThresholdHarness);
		const disabledHarness = await createHarness({ settings: { compaction: { enabled: false } } });
		harnesses.push(disabledHarness);

		const belowThresholdSpy = stubRunAutoCompaction(belowThresholdHarness.session);
		const disabledSpy = stubRunAutoCompaction(disabledHarness.session);

		await checkCompaction(
			belowThresholdHarness.session,
			createAssistant(belowThresholdHarness, { stopReason: "stop", totalTokens: 1_000, timestamp: Date.now() }),
		);
		await checkCompaction(
			disabledHarness.session,
			createAssistant(disabledHarness, { stopReason: "stop", totalTokens: 1_000_000, timestamp: Date.now() }),
		);

		expect(belowThresholdSpy).not.toHaveBeenCalled();
		expect(disabledSpy).not.toHaveBeenCalled();
	});
});
