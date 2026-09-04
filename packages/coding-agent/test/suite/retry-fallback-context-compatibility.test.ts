import type { AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { type CandidateUsability, RetryFallbackController } from "../../src/core/retry-fallback/controller.ts";
import { SelectorCooldowns } from "../../src/core/retry-fallback/cooldown.ts";
import type { RetryFallbackExhaustedEvent } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

type SwitchRecord = {
	readonly model: string;
	readonly thinking: ThinkingLevel;
};

function seedLiveContext(harness: Harness, tokens: number): void {
	const timestamp = Date.now();
	const primary = harness.getModel();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "continue the interrupted task" }],
		timestamp: timestamp - 1,
	});
	harness.sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "progress before provider failure" }],
		api: primary.api,
		provider: primary.provider,
		model: primary.id,
		stopReason: "stop",
		usage: {
			input: tokens - 1_000,
			output: 1_000,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: tokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function model(id: string): Model<Api> {
	return {
		...getModel("openai", "gpt-5.4"),
		provider: "faux",
		id,
	};
}

describe("retry fallback context compatibility", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("skips a context-incompatible rung and switches to the next compatible model", async () => {
		// given
		const primary = model("primary");
		const incompatible = model("incompatible");
		const compatible = model("compatible");
		const models = [primary, incompatible, compatible];
		const switches: SwitchRecord[] = [];
		let current = { model: primary, thinkingLevel: "high" as ThinkingLevel };
		const deps = {
			getSettings: () => ({
				modelFallback: true,
				chains: { "faux/primary": ["faux/incompatible", "faux/compatible"] },
			}),
			registry: {
				find: (provider: string, id: string) =>
					models.find((candidate) => candidate.provider === provider && candidate.id === id),
				getAll: () => models,
			},
			cooldowns: new SelectorCooldowns(() => 0),
			logger: { debug: () => {}, info: () => {}, warn: () => {} },
			isCandidateUsable: (candidate: Model<Api>): CandidateUsability =>
				candidate.id === "incompatible" ? { usable: false } : { usable: true },
			switchModel: async (candidate: Model<Api>, thinking: ThinkingLevel) => {
				switches.push({ model: candidate.id, thinking });
				current = { model: candidate, thinkingLevel: thinking };
			},
			emit: () => {},
			getCurrentSelector: () => current,
			isAuthAvailable: () => true,
		};
		const controller = new RetryFallbackController(deps);

		// when
		const switched = await controller.tryFallback("hard-error", { errorMessage: "upstream unavailable" });

		// then
		expect(switched).toBe(true);
		expect(switches).toEqual([{ model: "compatible", thinking: "high" }]);
	});

	it("accepts a fallback with an unknown context window", async () => {
		// given
		const harness = await createHarness({
			models: [
				{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 4_000 },
				{ id: "faux-2", contextWindow: 0, maxTokens: 4_000 },
			],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 0,
					baseDelayMs: 1,
					fallbackChains: { "faux/faux-1": ["faux/faux-2"] },
				},
			},
		});
		harnesses.push(harness);
		const internals = harness.session as unknown as {
			_handleRetryableError: (
				message: ReturnType<typeof fauxAssistantMessage>,
				options: { hardErrorFallback: boolean },
			) => Promise<string>;
		};

		// when
		await internals._handleRetryableError(
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream unavailable" }),
			{ hardErrorFallback: true },
		);

		// then
		expect(harness.session.model?.id).toBe("faux-2");
		expect(harness.sessionManager.getEntries()).toContainEqual(
			expect.objectContaining({ type: "model_change", modelId: "faux-2", reason: "fallback" }),
		);
	});

	it("rolls back a post-model-select budget rejection without persisting a fallback switch", async () => {
		// given
		const primaryTool: AgentTool = {
			name: "primary_tool",
			label: "Primary",
			description: "Primary model tool.",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "primary" }], details: {} }),
		};
		const fallbackTool: AgentTool = {
			name: "fallback_tool",
			label: "Fallback",
			description: "Fallback model tool.",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "fallback" }], details: {} }),
		};
		const harness = await createHarness({
			models: [
				{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 4_000 },
				{ id: "faux-2", contextWindow: 80_000, maxTokens: 4_000 },
			],
			systemPrompt: "primary prompt",
			tools: [primaryTool, fallbackTool],
			initialActiveToolNames: ["primary_tool"],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 0,
					baseDelayMs: 1,
					fallbackChains: { "faux/faux-1": ["faux/faux-2"] },
				},
			},
			extensionFactories: [
				(pi) => {
					pi.on("model_select", (event) => {
						if (event.model.id === "faux-2") {
							pi.setActiveTools(["fallback_tool"]);
							return { systemPrompt: "oversized ".repeat(40_000), systemPromptName: "oversized" };
						}
						pi.setActiveTools(["primary_tool"]);
						return { systemPrompt: "primary prompt", systemPromptName: "primary" };
					});
				},
			],
		});
		harnesses.push(harness);
		const originalSystemPrompt = harness.session.systemPrompt;
		const internals = harness.session as unknown as {
			_handleRetryableError: (
				message: ReturnType<typeof fauxAssistantMessage>,
				options: { hardErrorFallback: boolean },
			) => Promise<string>;
		};

		// when
		const result = await internals
			._handleRetryableError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream unavailable" }),
				{ hardErrorFallback: true },
			)
			.then(
				(value) => ({ kind: "returned" as const, value }),
				(error: unknown) => ({ kind: "threw" as const, error }),
			);

		// then
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "model_change")).toEqual([]);
		expect(harness.session.model?.id).toBe("faux-1");
		expect(harness.session.systemPrompt).toBe(originalSystemPrompt);
		expect(harness.session.getActiveToolNames()).toEqual(["primary_tool"]);
		expect(result).toEqual({ kind: "returned", value: "not-handled" });
	});

	it("emits one extension-visible exhaustion event when every fallback is context-incompatible", async () => {
		// given
		const extensionEvents: RetryFallbackExhaustedEvent[] = [];
		const harness = await createHarness({
			models: [
				{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 4_000 },
				{ id: "faux-2", contextWindow: 80_000, maxTokens: 4_000 },
			],
			settings: {
				retry: {
					enabled: true,
					maxRetries: 0,
					baseDelayMs: 1,
					fallbackChains: { "faux/faux-1": ["faux/faux-2"] },
				},
			},
			extensionFactories: [
				(pi) => {
					pi.on("retry_fallback_exhausted", (event) => {
						extensionEvents.push(event);
					});
				},
			],
		});
		harnesses.push(harness);
		seedLiveContext(harness, 90_000);
		const internals = harness.session as unknown as {
			_handleRetryableError: (
				message: ReturnType<typeof fauxAssistantMessage>,
				options: { hardErrorFallback: boolean },
			) => Promise<string>;
		};

		// when
		await internals
			._handleRetryableError(
				fauxAssistantMessage("", { stopReason: "error", errorMessage: "upstream unavailable" }),
				{ hardErrorFallback: true },
			)
			.catch(() => undefined);

		// then
		expect(extensionEvents).toMatchObject([
			{
				type: "retry_fallback_exhausted",
				sessionId: harness.session.sessionId,
				chainKey: "faux/faux-1",
				from: "faux/faux-1",
				exhaustionReason: "no-context-compatible-candidate",
				rejectedCandidates: [
					{
						selector: "faux/faux-2",
						reason: "context-unusable",
						projection: { usable: false },
					},
				],
			},
		]);
		expect(harness.eventsOfType("retry_fallback_exhausted")).toMatchObject([
			{ chainKey: "faux/faux-1", lastError: "upstream unavailable" },
		]);
	});
});
