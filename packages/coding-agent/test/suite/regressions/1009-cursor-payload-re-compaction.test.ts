import type { StreamFn } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { estimateContextTokens } from "../../../src/core/compaction/index.ts";
import compactionExtension from "../../../src/core/extensions/builtin/compaction/index.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/index.ts";
import type { CompactionReason } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

const CURSOR_PAYLOAD_RE_MIN_ESTIMATE = 50_000;
const ZERO_TOKEN_RE = "Connect error resource_exhausted: Error";
const PRIMARY = "cursor/composer";
const FALLBACK = "cursor/k3";

/** Prose-like payload so the chars/4 estimate stays >= 50k without the 4x base64-run weight. */
const LARGE_TRANSCRIPT = Array.from({ length: 12_000 }, (_, index) => `turn-${index} context payload`).join(" ");

function zeroUsage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function isResourceExhausted(message: { errorMessage?: string } | undefined): boolean {
	return /resource.?exhausted/i.test(message?.errorMessage ?? "");
}

function zeroUsageIfResourceExhausted(message: AssistantMessage): AssistantMessage {
	if (!isResourceExhausted(message)) return message;
	return { ...message, usage: zeroUsage() };
}

function zeroUsageEvent(event: AssistantMessageEvent): AssistantMessageEvent {
	if (event.type === "error" && isResourceExhausted(event.error)) {
		return { ...event, error: zeroUsageIfResourceExhausted(event.error) };
	}
	if (event.type === "done" && isResourceExhausted(event.message)) {
		return { ...event, message: zeroUsageIfResourceExhausted(event.message) };
	}
	if ("partial" in event && event.partial && isResourceExhausted(event.partial)) {
		return { ...event, partial: zeroUsageIfResourceExhausted(event.partial) };
	}
	return event;
}

/**
 * Faux streams stamp estimated prompt usage onto every terminal message.
 * Issue #1009 is a 0-token Cursor RE, so strip that estimate after the faux provider returns.
 */
function forceZeroTokenResourceExhausted(streamFn: StreamFn): StreamFn {
	return async (model, context, options) => {
		const stream = await streamFn(model, context, options);
		const originalResult = stream.result.bind(stream);
		const originalIterator = stream[Symbol.asyncIterator].bind(stream);
		stream.result = async () => zeroUsageIfResourceExhausted(await originalResult());
		stream[Symbol.asyncIterator] = () => {
			const iterator = originalIterator();
			return {
				async next() {
					const result = await iterator.next();
					if (result.done) return result;
					return { done: false, value: zeroUsageEvent(result.value) };
				},
			};
		};
		return stream;
	};
}

function seedLargeCursorTranscript(harness: Harness): void {
	const now = Date.now();
	const model = harness.getModel();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: LARGE_TRANSCRIPT }],
		timestamp: now - 4_000,
	});
	harness.sessionManager.appendMessage({
		...fauxAssistantMessage("prior turn", { timestamp: now - 3_000 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
	});
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "keep going" }],
		timestamp: now - 2_000,
	});
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

describe("issue #1009: Cursor 0-token RE still overflow-compacts under idle guards", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("reaches overflow auto-compaction for a large Cursor 0-token RE without falling back", async () => {
		const compactReasons: CompactionReason[] = [];
		const idleAtCompactionStart: boolean[] = [];
		const harness = await createHarness({
			provider: "cursor",
			models: [
				{ id: "composer", contextWindow: 200_000, maxTokens: 16_384 },
				{ id: "k3", contextWindow: 200_000, maxTokens: 16_384 },
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
				compactionExtension,
				(pi: ExtensionAPI) => {
					pi.on("session_before_compact", (event) => {
						compactReasons.push(event.reason);
						return {
							compaction: {
								summary: "overflow recovery summary",
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
		expect(harness.getModel().provider).toBe("cursor");
		harness.agent.streamFunction = forceZeroTokenResourceExhausted(harness.agent.streamFunction);
		seedLargeCursorTranscript(harness);
		expect(estimateContextTokens(harness.session.agent.state.messages).tokens).toBeGreaterThanOrEqual(
			CURSOR_PAYLOAD_RE_MIN_ESTIMATE,
		);

		harness.session.subscribe((event) => {
			if (event.type === "compaction_start") {
				idleAtCompactionStart.push(harness.session.isIdle);
			}
		});
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: ZERO_TOKEN_RE }),
			fauxAssistantMessage("compact summary"),
			fauxAssistantMessage("compact summary"),
			fauxAssistantMessage("recovered after overflow compact"),
			fauxAssistantMessage("recovered after overflow compact"),
		]);

		await harness.session.prompt("continue the large session");

		const overflowStarts = harness.eventsOfType("compaction_start").filter((event) => event.reason === "overflow");
		const zeroTokenRe = harness
			.eventsOfType("message_end")
			.find(
				(event) =>
					event.message.role === "assistant" &&
					/resource.?exhausted/i.test("errorMessage" in event.message ? (event.message.errorMessage ?? "") : ""),
			);

		expect(zeroTokenRe?.message).toMatchObject({
			stopReason: "error",
			usage: expect.objectContaining({ input: 0, output: 0, totalTokens: 0 }),
		});
		expect(compactReasons).toContain("overflow");
		expect(overflowStarts.length).toBeGreaterThan(0);
		expect(idleAtCompactionStart).toContain(false);
		expect(harness.eventsOfType("retry_fallback_applied")).toEqual([]);
		expect(harness.faux.getCallLog().every((call) => call.modelId === "composer")).toBe(true);
	});
});
