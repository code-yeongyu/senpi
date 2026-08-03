import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createFileOps, DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import { classifyRequiredCompactionFallbackFailure } from "../../src/core/extensions/builtin/compaction/deterministic-fallback.ts";
import {
	runExtensionCompaction,
	type SpeculativeCompactionContext,
	type SpeculativeCompactionSnapshot,
} from "../../src/core/extensions/builtin/compaction/speculative.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

/**
 * Issue #650: on gpt-5.6 (openai-codex) a wedged blocking compaction burned
 * ~13.5M billed tokens across dozens of sequential summarization attempts.
 * The provider rejected an oversized summarization request that senpi's
 * estimator believed fit (provider-side input includes replayed reasoning
 * the estimator cannot see), and each retry dropped exactly one history
 * item before re-billing a full summarization stream.
 */

const CONTEXT_WINDOW = 8_000;
const HISTORY_MESSAGE_COUNT = 40;
const HISTORY_MESSAGE_CHARS = 1_200;
const EXPECTED_MAX_OVERFLOW_RETRIES = 3;

function oversizedHistory(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		role: "assistant" as const,
		content: [{ type: "text" as const, text: `history-${index} ${"x".repeat(HISTORY_MESSAGE_CHARS)}` }],
		timestamp: index,
	}));
}

const PROVIDER_HARD_LIMIT_MESSAGE = "Your input exceeds the context window of this model";

function createOverflowingModelContext() {
	const registration = registerFauxProvider({ models: [{ id: "gpt-5.6-sol", contextWindow: CONTEXT_WINDOW }] });
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

function queueProviderHardLimitResponses(
	registration: ReturnType<typeof registerFauxProvider>,
	count: number,
	text = "discarded summary that the provider rejects as oversized",
): void {
	registration.setResponses(
		Array.from(
			{ length: count },
			() => () => fauxAssistantMessage(text, { stopReason: "error", errorMessage: PROVIDER_HARD_LIMIT_MESSAGE }),
		),
	);
}

function requestContentTokens(call: { context: { messages: readonly unknown[] } }): number {
	let total = 0;
	for (const message of call.context.messages) {
		const content = (message as { content?: readonly { text?: string }[] }).content ?? [];
		for (const block of content) total += Math.ceil((block.text ?? "").length / 4);
	}
	return total;
}

describe("compaction overflow retry bound (issue #650)", () => {
	it("Given a provider that always rejects the input When compaction runs Then billed attempts stop at the cap and degrade classifiably", async () => {
		const { registration, context, snapshot } = createOverflowingModelContext();
		queueProviderHardLimitResponses(registration, 12);

		const failure = await runExtensionCompaction(context, snapshot).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(registration.state.callCount).toBeLessThanOrEqual(1 + EXPECTED_MAX_OVERFLOW_RETRIES);
		expect(failure).toBeInstanceOf(Error);
		expect(classifyRequiredCompactionFallbackFailure(failure)).not.toBeUndefined();
	});

	it("Given an oversized summarization input When compaction runs Then every billed request fits the input budget", async () => {
		const { registration, context, snapshot } = createOverflowingModelContext();
		queueProviderHardLimitResponses(registration, 12);

		await runExtensionCompaction(context, snapshot).then(
			() => undefined,
			() => undefined,
		);

		const callLog = registration.getCallLog();
		expect(callLog.length).toBeGreaterThan(0);
		for (const call of callLog) {
			expect(requestContentTokens(call)).toBeLessThanOrEqual(Math.floor(CONTEXT_WINDOW * 0.6));
		}
	});

	it("Given retries When the input shrinks Then it shrinks geometrically instead of one message at a time", async () => {
		const { registration, context, snapshot } = createOverflowingModelContext();
		queueProviderHardLimitResponses(registration, 12);

		await runExtensionCompaction(context, snapshot).then(
			() => undefined,
			() => undefined,
		);

		const messageCounts = registration.getCallLog().map((call) => call.context.messages.length);
		expect(messageCounts.length).toBeGreaterThan(1);
		for (let index = 1; index < messageCounts.length; index++) {
			const previous = messageCounts[index - 1] ?? 0;
			const current = messageCounts[index] ?? 0;
			expect(current).toBeLessThanOrEqual(Math.ceil(previous / 2) + 1);
		}
	});

	it("Given slow rejected attempts When the cumulative budget elapses Then no further billed attempt is scheduled", async () => {
		vi.useFakeTimers();
		try {
			const { registration, context, snapshot } = createOverflowingModelContext();
			// ~100s of streaming per attempt at 10 tokens/s: under the 120s
			// per-attempt watchdog, so every attempt completes and is rejected;
			// only a cross-attempt budget can stop the loop.
			const slowRejection = () =>
				fauxAssistantMessage(`discarded ${"y".repeat(4_000)}`, {
					stopReason: "error",
					errorMessage: PROVIDER_HARD_LIMIT_MESSAGE,
				});
			registration.setResponses(Array.from({ length: 12 }, () => slowRejection));

			const settled = runExtensionCompaction(context, snapshot).then(
				() => "resolved" as const,
				(error: unknown) => error,
			);
			let outcome: "resolved" | unknown | undefined;
			void settled.then((value) => {
				outcome = value;
			});
			for (let step = 0; step < 600 && outcome === undefined; step++) {
				await vi.advanceTimersByTimeAsync(1_000);
			}

			expect(outcome).not.toBe("resolved");
			// Attempts complete at ~100s each; a 240s cross-attempt budget stops the
			// loop after the third attempt, one earlier than the retry cap alone.
			expect(registration.state.callCount).toBeLessThanOrEqual(EXPECTED_MAX_OVERFLOW_RETRIES);
			expect(classifyRequiredCompactionFallbackFailure(outcome)).not.toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});
