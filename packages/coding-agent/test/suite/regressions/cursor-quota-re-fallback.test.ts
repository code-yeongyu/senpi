import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import compactionExtension from "../../../src/core/extensions/builtin/compaction/index.ts";
import type { CompactionReason } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

const PRIMARY = "cursor/composer";
const FALLBACK = "cursor/k3";

function quotaError(input = 178_626): ReturnType<typeof fauxAssistantMessage> {
	const message = fauxAssistantMessage(fauxToolCall("partial_tool", {}), {
		stopReason: "error",
		errorMessage: "Connect error resource_exhausted: Error",
	});
	message.usage = {
		...message.usage,
		input,
		totalTokens: input,
	};
	return message;
}

describe("Cursor token-bearing resource_exhausted quota fallback", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("falls back after required compaction fails and continues on the next model", async () => {
		const harness = await createHarness({
			provider: "cursor",
			models: [
				{ id: "composer", contextWindow: 200_000, maxTokens: 16_384 },
				{ id: "k3", contextWindow: 200_000, maxTokens: 16_384 },
			],
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 16_384 },
				retry: { enabled: true, maxRetries: 0, baseDelayMs: 1, fallbackChains: { [PRIMARY]: [FALLBACK] } },
			},
			extensionFactories: [
				compactionExtension,
				(pi) => {
					pi.on("session_before_compact", () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		const originalStream = harness.agent.streamFunction;
		let firstProviderCall = true;
		harness.agent.streamFunction = async (...args) => {
			if (firstProviderCall) {
				firstProviderCall = false;
				harness.sessionManager.appendMessage({
					role: "user",
					content: [{ type: "text", text: "large prior context ".repeat(45_000) }],
					timestamp: Date.now() - 2_000,
				});
				harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
			}
			return originalStream(...args);
		};
		harness.setResponses([
			quotaError(50_000),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "compaction generator failed" }),
			fauxAssistantMessage("continued after compaction failure"),
		]);

		await harness.session.prompt("continue");

		expect(harness.eventsOfType("compaction_end")).toMatchObject([
			{ accepted: false, rejectionCause: "cancelled-by-extension", willRetry: false },
		]);
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["composer", "k3"]);
		expect(harness.eventsOfType("retry_fallback_applied")).toMatchObject([{ to: FALLBACK, reason: "hard-error" }]);
	});

	it("falls back without compaction and continues the turn", async () => {
		const compactReasons: CompactionReason[] = [];
		const harness = await createHarness({
			provider: "cursor",
			models: [
				{ id: "composer", contextWindow: 1_048_576, maxTokens: 16_384 },
				{ id: "k3", contextWindow: 1_048_576, maxTokens: 16_384 },
			],
			settings: {
				compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 16_384 },
				retry: {
					enabled: true,
					maxRetries: 3,
					baseDelayMs: 1,
					fallbackChains: { [PRIMARY]: [FALLBACK] },
				},
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => {
						compactReasons.push(event.reason);
						return {
							compaction: {
								summary: "unexpected compaction",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([quotaError(), fauxAssistantMessage("continued on fallback")]);

		await harness.session.prompt("continue");

		expect(compactReasons).toEqual([]);
		expect(harness.eventsOfType("retry_fallback_applied")).toHaveLength(1);
		expect(harness.faux.getCallLog().map((call) => call.modelId)).toEqual(["composer", "k3"]);
		expect(harness.eventsOfType("message_end").at(-1)?.message).toMatchObject({
			role: "assistant",
			stopReason: "stop",
		});
	});
});
