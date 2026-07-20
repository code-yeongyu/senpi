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

	it("removes only the failed assistant while preserving state across a fallback switch", async () => {
		const snapshotTool: AgentTool = {
			name: "snapshot",
			label: "Snapshot",
			description: "Provides stable tool state for fallback assertions.",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text", text: "snapshot" }],
				details: {},
			}),
		};
		const harness = await createHarness({
			models: [{ id: "faux-1" }, { id: "faux-2" }],
			tools: [snapshotTool],
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
			fauxAssistantMessage("first"),
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "overloaded_error",
			}),
			fauxAssistantMessage("recovered"),
		]);
		await harness.session.prompt("first turn");

		let stateBeforeFailedAssistant: typeof harness.session.state.messages | undefined;
		let systemPromptBeforeFailedAssistant: string | undefined;
		let toolsBeforeFailedAssistant: unknown;
		let fallbackRequestMessages: unknown;
		let stateAtFallbackRequest: typeof harness.session.state.messages | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "auto_retry_start") {
				stateBeforeFailedAssistant = structuredClone(harness.session.state.messages);
				systemPromptBeforeFailedAssistant = harness.session.state.systemPrompt;
				toolsBeforeFailedAssistant = JSON.parse(JSON.stringify(harness.session.state.tools));
			}
		});
		harness.setResponses([
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "overloaded_error",
			}),
			(context) => {
				fallbackRequestMessages = structuredClone(context.messages);
				stateAtFallbackRequest = structuredClone(harness.session.state.messages);
				return fauxAssistantMessage("recovered");
			},
		]);

		await harness.session.prompt("second turn");

		if (
			!stateBeforeFailedAssistant ||
			systemPromptBeforeFailedAssistant === undefined ||
			!toolsBeforeFailedAssistant
		) {
			throw new Error("Missing pre-error fallback snapshot");
		}
		expect(stateAtFallbackRequest).toEqual(stateBeforeFailedAssistant.slice(0, -1));
		expect(fallbackRequestMessages).toEqual(stateBeforeFailedAssistant.slice(0, -1));
		expect(harness.session.state.systemPrompt).toBe(systemPromptBeforeFailedAssistant);
		expect(JSON.stringify(harness.session.state.systemPrompt)).toBe(
			JSON.stringify(systemPromptBeforeFailedAssistant),
		);
		expect(JSON.stringify(harness.session.state.tools)).toBe(JSON.stringify(toolsBeforeFailedAssistant));
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
