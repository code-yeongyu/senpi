import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createFileOps, DEFAULT_COMPACTION_SETTINGS } from "../../src/core/compaction/index.ts";
import {
	runExtensionCompaction,
	type SpeculativeCompactionContext,
	type SpeculativeCompactionSnapshot,
} from "../../src/core/extensions/builtin/compaction/speculative.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

/**
 * Incident 2026-08-16 (Discord IMG_1221.jpg): gemini-3.7-flash-high rejected
 * the compaction summarization request twice with
 * "400 INVALID_ARGUMENT: Please ensure that function call turn comes
 * immediately after a user turn or after a function response turn".
 *
 * Gemini rejects a functionCall model turn that follows another model turn,
 * and rejects a conversation whose first turn is not a user turn. Real
 * sessions contain adjacent assistant messages (split turns, retries), and
 * budget pruning/shrinking can drop the leading user message — both shapes
 * flow straight into the request today.
 */

const CONTEXT_WINDOW = 8_000;

function textMessage(role: "user" | "assistant", text: string, timestamp: number) {
	return { role, content: [{ type: "text" as const, text }], timestamp };
}

function toolCallingAssistant(text: string, callId: string, timestamp: number) {
	return {
		role: "assistant" as const,
		content: [
			{ type: "text" as const, text },
			{ type: "toolCall" as const, id: callId, name: "bash", arguments: { command: "ls" } },
		],
		timestamp,
	};
}

function toolResultMessage(callId: string, timestamp: number) {
	return {
		role: "toolResult" as const,
		toolCallId: callId,
		toolName: "bash",
		content: [{ type: "text" as const, text: "ok" }],
		timestamp,
	};
}

function createModelContext(messagesToSummarize: ReturnType<typeof Array.prototype.concat.call>) {
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
			messagesToSummarize,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 4_000,
			fileOps: createFileOps(),
			settings: { ...DEFAULT_COMPACTION_SETTINGS },
		},
		promptVariant: "default" as const,
		origin: "blocking" as const,
		systemPrompt: "",
	} as unknown as SpeculativeCompactionSnapshot;
	return { registration, context, snapshot };
}

function requestRoles(registration: ReturnType<typeof registerFauxProvider>, callIndex: number): string[] {
	const call = registration.getCallLog()[callIndex];
	if (!call) throw new Error(`expected provider call ${callIndex}`);
	return call.context.messages.map((message) => (message as { role: string }).role);
}

describe("compaction summarization request turn order (Gemini function-call rule)", () => {
	it("Given adjacent assistant messages in the history When compaction runs Then the request has no adjacent assistants and starts with a user message", async () => {
		const history = [
			textMessage("user", "please continue", 1),
			textMessage("assistant", "first half of the answer", 2),
			toolCallingAssistant("second half, calling a tool", "call-1", 3),
			toolResultMessage("call-1", 4),
			textMessage("user", "thanks", 5),
		];
		const { registration, context, snapshot } = createModelContext(history);
		registration.setResponses([() => fauxAssistantMessage("A compact summary.")]);

		const result = await runExtensionCompaction(context, snapshot);

		expect(result).toBeDefined();
		const roles = requestRoles(registration, 0);
		expect(roles[0]).toBe("user");
		for (let index = 1; index < roles.length; index++) {
			expect(!(roles[index - 1] === "assistant" && roles[index] === "assistant")).toBe(true);
		}
	});

	it("Given an overflow retry whose shrink drops the leading user message When compaction runs Then every attempt still starts with a user message", async () => {
		const history = Array.from({ length: 40 }, (_, index) =>
			textMessage(index % 2 === 0 ? "user" : "assistant", `entry-${index} ${"y".repeat(1_200)}`, index),
		);
		const { registration, context, snapshot } = createModelContext(history);
		registration.setResponses([
			() =>
				fauxAssistantMessage("discarded", {
					stopReason: "error",
					errorMessage: "Your input exceeds the context window of this model",
				}),
			() => fauxAssistantMessage("A compact summary."),
		]);

		const result = await runExtensionCompaction(context, snapshot);

		expect(result).toBeDefined();
		expect(registration.state.callCount).toBeGreaterThan(1);
		for (let callIndex = 0; callIndex < registration.state.callCount; callIndex++) {
			expect(requestRoles(registration, callIndex)[0]).toBe("user");
		}
	});
});
