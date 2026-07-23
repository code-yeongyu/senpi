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
});
