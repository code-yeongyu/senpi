import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createFileOps, DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import { classifyRequiredCompactionFallbackFailure } from "../../src/core/extensions/builtin/compaction/deterministic-fallback.ts";
import {
	boundSummarizationInput,
	estimateTotalTokens,
	summarizationHistoryBudget,
} from "../../src/core/extensions/builtin/compaction/overflow-retry.ts";
import {
	runExtensionCompaction,
	type SpeculativeCompactionContext,
	type SpeculativeCompactionSnapshot,
} from "../../src/core/extensions/builtin/compaction/speculative.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

/**
 * Incident 2026-08-16 (Discord IMG_1221.jpg): a session over the compaction
 * threshold had its summarization request rejected by every fallback-chain
 * model — gateway 413 "Request body too large" / "Request Entity Too Large",
 * then a 120s wall-clock stall — wedging the session on
 * "Compaction rejected: compaction generator failed: 413 ...".
 *
 * Root cause: those 413 wordings were not classified as context overflow, so
 * the halving shrink-retry never engaged and the failure never reached the
 * deterministic fallback classifier. A byte-size rejection is the same
 * recovery class as a token-window overflow: shrink the input and retry, then
 * degrade deterministically.
 */

const CONTEXT_WINDOW = 8_000;
const HISTORY_MESSAGE_COUNT = 40;
const HISTORY_MESSAGE_CHARS = 1_200;

const GATEWAY_413_OPENAI_STYLE =
	'413: {"message":"Request body too large","type":"invalid_request_error","code":"body_too_large"}';
const GATEWAY_413_AI_SDK_STYLE =
	'413: {"message":"Request Entity Too Large","type":"AI_APICallError","param":{"error":"Request Entity Too Large","statusCode":413,"name":"AI_APICallError","message":"Request Entity Too Large","isRetryable":false,"type":"AI_APICallError"}}';

function oversizedHistory(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
		content: [{ type: "text" as const, text: `history-${index} ${"x".repeat(HISTORY_MESSAGE_CHARS)}` }],
		timestamp: index,
	}));
}

function createModelContext() {
	const registration = registerFauxProvider({ models: [{ id: "gateway-model", contextWindow: CONTEXT_WINDOW }] });
	const model = registration.getModel();
	const sessionManager = SessionManager.inMemory();
	const modelRegistry = Object.create(null) as SpeculativeCompactionContext["modelRegistry"];
	if (modelRegistry) {
		modelRegistry.getApiKeyAndHeaders = vi.fn(async () => ({ ok: true as const, apiKey: "test-key" }));
	}
	const context = {
		model,
		sessionManager,
		modelRegistry,
		getContextUsage: () => ({ tokens: 0, percent: 0, contextWindow: CONTEXT_WINDOW }),
		getMessageRevision: () => 1,
		applyCompaction: vi.fn(async () => ({ applied: true as const, reason: "ok" as const })),
	} as unknown as SpeculativeCompactionContext;
	const snapshot = {
		generation: 1,
		expectedRevision: 1,
		model,
		contextWindow: CONTEXT_WINDOW,
		preparation: {
			firstKeptEntryId: "keep",
			messagesToSummarize: oversizedHistory(HISTORY_MESSAGE_COUNT),
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 12_000,
			fileOps: createFileOps(),
			settings: { ...DEFAULT_COMPACTION_SETTINGS },
		},
		promptVariant: "default" as const,
		origin: "blocking" as const,
		systemPrompt: "",
	} as unknown as SpeculativeCompactionSnapshot;
	return { registration, context, snapshot };
}

function queue413(registration: ReturnType<typeof registerFauxProvider>, count: number, message: string): void {
	registration.setResponses(
		Array.from(
			{ length: count },
			() => () => fauxAssistantMessage("discarded", { stopReason: "error", errorMessage: message }),
		),
	);
}

describe("compaction summarization vs gateway 413 body-size rejections", () => {
	it("Given a provider that 413s twice then accepts When compaction runs Then the input shrinks per attempt and a summary is produced", async () => {
		const { registration, context, snapshot } = createModelContext();
		registration.setResponses([
			() => fauxAssistantMessage("discarded", { stopReason: "error", errorMessage: GATEWAY_413_OPENAI_STYLE }),
			() => fauxAssistantMessage("discarded", { stopReason: "error", errorMessage: GATEWAY_413_OPENAI_STYLE }),
			() => fauxAssistantMessage("A compact summary of the conversation."),
		]);

		const result = await runExtensionCompaction(context, snapshot);

		expect(result).toBeDefined();
		expect(result?.summary).toContain("compact summary");
		expect(registration.state.callCount).toBe(3);
		const messageCounts = registration.getCallLog().map((call) => call.context.messages.length);
		for (let index = 1; index < messageCounts.length; index++) {
			expect(messageCounts[index]).toBeLessThan(messageCounts[index - 1] ?? 0);
		}
	});

	it("Given a provider that always 413s (AI SDK wording) When compaction runs Then attempts shrink and exhaustion degrades classifiably", async () => {
		const { registration, context, snapshot } = createModelContext();
		queue413(registration, 12, GATEWAY_413_AI_SDK_STYLE);

		const failure = await runExtensionCompaction(context, snapshot).then(
			() => undefined,
			(error: unknown) => error,
		);

		// The shrink-retry must engage (more than the single first attempt) and
		// exhaustion must be classifiable for the deterministic fallback — the
		// two properties whose absence wedged the incident session.
		expect(registration.state.callCount).toBeGreaterThan(1);
		expect(failure).toBeInstanceOf(Error);
		expect(classifyRequiredCompactionFallbackFailure(failure)).not.toBeUndefined();
	});

	it("Given a provider that always 413s (OpenAI wording) When compaction runs Then exhaustion degrades classifiably", async () => {
		const { registration, context, snapshot } = createModelContext();
		queue413(registration, 12, GATEWAY_413_OPENAI_STYLE);

		const failure = await runExtensionCompaction(context, snapshot).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(registration.state.callCount).toBeGreaterThan(1);
		expect(failure).toBeInstanceOf(Error);
		expect(classifyRequiredCompactionFallbackFailure(failure)).not.toBeUndefined();
	});
});

describe("summarization input sizing for CJK transcripts", () => {
	it("Given Korean-heavy messages When estimating the input size Then the estimate reflects real token density", () => {
		// Korean tokenizes near one token per 1.5 characters; a chars/4
		// estimate claims ~4x fewer tokens and undersizes the request bound,
		// which is how the incident session's first attempt went out oversized.
		const korean = "안녕하세요 컴팩션 요약 요청이 너무 커서 실패했습니다 ".repeat(80);
		const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: korean }], timestamp: 1 }];
		expect(estimateTotalTokens(messages)).toBeGreaterThanOrEqual(Math.floor(korean.length / 1.6));
	});

	it("Given equal-length Korean and ASCII histories When the input is bounded Then the Korean history is pruned harder", () => {
		const buildHistory = (text: (index: number) => string) =>
			Array.from({ length: 30 }, (_, index) => ({
				role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
				content: [{ type: "text" as const, text: text(index) }],
				timestamp: index,
			})) as unknown as AgentMessage[];
		const korean = buildHistory((index) => `히스토리 ${index} ${"한국어 내용 ".repeat(200)}`);
		const ascii = buildHistory((index) => `history ${index} ${"english prose ".repeat(200)}`);
		const boundedKorean = boundSummarizationInput(korean, CONTEXT_WINDOW, 100);
		const boundedAscii = boundSummarizationInput(ascii, CONTEXT_WINDOW, 100);
		expect(boundedKorean.length).toBeLessThan(boundedAscii.length);
		expect(estimateTotalTokens(boundedKorean)).toBeLessThanOrEqual(summarizationHistoryBudget(CONTEXT_WINDOW, 100));
	});
});
