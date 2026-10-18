import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { AssistantMessage, Model, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const mockState = vi.hoisted(() => ({
	chunkSets: [] as unknown[][],
	payloads: [] as unknown[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (payload: unknown) => {
					mockState.payloads.push(payload);
					const chunks = mockState.chunkSets.shift() ?? [];
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of chunks) {
								yield chunk;
							}
						},
					};
					const result = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{ data: typeof stream; response: { status: number; headers: Headers } }>;
					};
					result.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return result;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

const reasoningDetail = { type: "reasoning.encrypted", id: "call_1", data: "encrypted-signature" };
const signedReasoningTextDetail = {
	type: "reasoning.text",
	text: "I should call the read tool.",
	signature: "sha256:signed-text",
	id: "reasoning-text-1",
	format: "anthropic-claude-v1",
	index: 0,
};
const reasoningSummaryDetail = {
	type: "reasoning.summary",
	summary: "Decided to inspect the requested file.",
	id: "reasoning-summary-1",
	format: "anthropic-claude-v1",
	index: 1,
};
const readTool: Tool = {
	name: "read",
	description: "Read a file",
	parameters: Type.Object({ path: Type.String() }),
};

function model(): Model<"openai-completions"> {
	return {
		id: "google/gemini-test",
		name: "Gemini Test",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4096,
	};
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): unknown {
	return {
		id: "chatcmpl-test",
		model: "google/gemini-test",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
}

function toolCallChunk(): unknown {
	return chunk({
		tool_calls: [
			{
				index: 0,
				id: "call_1",
				type: "function",
				function: { name: "read", arguments: '{"path":"README.md"}' },
			},
		],
	});
}

async function runOpenAICompletionsStream(messages: AssistantMessage[] = []): Promise<AssistantMessage> {
	return await streamOpenAICompletions(model(), normalizeContext({ messages, tools: [readTool] }), {
		apiKey: "test",
	}).result();
}

function getAssistantPayload(payload: unknown): { reasoning?: unknown; reasoning_details?: unknown } | undefined {
	const messages = (
		payload as { messages?: Array<{ role?: string; reasoning?: unknown; reasoning_details?: unknown }> }
	).messages;
	return messages?.find((message) => message.role === "assistant");
}

// `index` is an output-side streaming-assembly artifact: it orders deltas while a
// response streams and carries no meaning on the input side, where the array's own
// order is the sequence. It stays in the stored signature and must never be replayed.
function withoutStreamingIndex<T extends Record<string, unknown>>(details: readonly T[]): Array<Omit<T, "index">> {
	return details.map(({ index: _index, ...rest }) => rest);
}

function storedAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "openrouter",
		model: "google/gemini-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function replayStoredThinking(signature: string): Promise<AssistantMessage> {
	mockState.chunkSets = [[chunk({ content: "ok" }), chunk({}, "stop")]];
	return runOpenAICompletionsStream([
		storedAssistantMessage([
			{ type: "thinking", thinking: "stored thinking", thinkingSignature: signature },
			{ type: "toolCall", id: "call_stored", name: "read", arguments: { path: "README.md" } },
		]),
	]);
}

describe("openai-completions reasoning_details streaming", () => {
	beforeEach(() => {
		mockState.chunkSets = [];
		mockState.payloads = [];
	});

	it("preserves reasoning_details in the thinking signature", async () => {
		mockState.chunkSets = [
			[chunk({ reasoning_details: [reasoningDetail] }), toolCallChunk(), chunk({}, "tool_calls")],
			[chunk({ content: "ok" }), chunk({}, "stop")],
		];

		const assistantMessage = await runOpenAICompletionsStream();
		const thinking = assistantMessage.content.find((block) => block.type === "thinking");
		expect(thinking).toEqual({
			type: "thinking",
			thinking: "",
			thinkingSignature: JSON.stringify([reasoningDetail]),
		});
		const toolCall = assistantMessage.content.find((block) => block.type === "toolCall");
		expect(toolCall).toEqual({
			type: "toolCall",
			id: "call_1",
			name: "read",
			arguments: { path: "README.md" },
		});

		await runOpenAICompletionsStream([assistantMessage]);

		expect(getAssistantPayload(mockState.payloads[1])?.reasoning_details).toEqual([reasoningDetail]);
	});

	it("falls back to encrypted tool-call signatures for older stored assistant messages", async () => {
		mockState.chunkSets = [
			[chunk({ reasoning_details: [reasoningDetail] }), toolCallChunk(), chunk({}, "tool_calls")],
			[chunk({ content: "ok" }), chunk({}, "stop")],
		];

		const assistantMessage = await runOpenAICompletionsStream();
		assistantMessage.content = assistantMessage.content.filter((block) => block.type !== "thinking");
		const toolCall = assistantMessage.content.find((block) => block.type === "toolCall");
		if (toolCall?.type !== "toolCall") throw new Error("Expected tool call");
		toolCall.thoughtSignature = JSON.stringify(reasoningDetail);

		await runOpenAICompletionsStream([assistantMessage]);

		expect(getAssistantPayload(mockState.payloads[1])?.reasoning_details).toEqual([reasoningDetail]);
	});

	it("preserves signed text and summary reasoning_details in their original sequence", async () => {
		mockState.chunkSets = [
			[
				chunk({ reasoning: signedReasoningTextDetail.text, reasoning_details: [signedReasoningTextDetail] }),
				chunk({ reasoning_details: [reasoningDetail, reasoningSummaryDetail] }),
				toolCallChunk(),
				chunk({}, "tool_calls"),
			],
			[chunk({ content: "ok" }), chunk({}, "stop")],
		];

		const assistantMessage = await runOpenAICompletionsStream();
		const expectedReasoningDetails = [signedReasoningTextDetail, reasoningDetail, reasoningSummaryDetail];
		const thinking = assistantMessage.content.find((block) => block.type === "thinking");
		expect(thinking).toEqual({
			type: "thinking",
			thinking: signedReasoningTextDetail.text,
			thinkingSignature: JSON.stringify(expectedReasoningDetails),
		});

		await runOpenAICompletionsStream([assistantMessage]);

		const payload = getAssistantPayload(mockState.payloads[1]);
		expect(payload?.reasoning_details).toEqual(withoutStreamingIndex(expectedReasoningDetails));
		expect(payload?.reasoning).toBeUndefined();
	});

	it("merges consecutive text and summary reasoning_details deltas before replay", async () => {
		const textDelta = { type: "reasoning.text", text: "The", index: 0 };
		const textDeltaWithSignature = {
			type: "reasoning.text",
			text: " user wants the time.",
			signature: "sha256:text-signature",
			format: "openai-responses-v1",
			index: 0,
		};
		const summaryDelta = { type: "reasoning.summary", summary: "Looked", index: 0 };
		const summaryDeltaWithFormat = {
			type: "reasoning.summary",
			summary: " up time.",
			format: "openai-responses-v1",
			index: 0,
		};
		const laterSummaryDelta = {
			type: "reasoning.summary",
			summary: "After encrypted block.",
			format: "openai-responses-v1",
			index: 0,
		};
		const expectedReasoningDetails = [
			{
				type: "reasoning.text",
				text: "The user wants the time.",
				index: 0,
				signature: "sha256:text-signature",
				format: "openai-responses-v1",
			},
			{
				type: "reasoning.summary",
				summary: "Looked up time.",
				index: 0,
				format: "openai-responses-v1",
			},
			reasoningDetail,
			laterSummaryDelta,
		];

		mockState.chunkSets = [
			[
				chunk({ reasoning_details: [textDelta] }),
				chunk({ reasoning_details: [textDeltaWithSignature] }),
				chunk({ reasoning_details: [summaryDelta] }),
				chunk({ reasoning_details: [summaryDeltaWithFormat] }),
				chunk({ reasoning_details: [reasoningDetail] }),
				chunk({ reasoning_details: [laterSummaryDelta] }),
				toolCallChunk(),
				chunk({}, "tool_calls"),
			],
			[chunk({ content: "ok" }), chunk({}, "stop")],
		];

		const assistantMessage = await runOpenAICompletionsStream();
		const thinking = assistantMessage.content.find((block) => block.type === "thinking");
		expect(thinking).toEqual({
			type: "thinking",
			thinking: "",
			thinkingSignature: JSON.stringify(expectedReasoningDetails),
		});

		await runOpenAICompletionsStream([assistantMessage]);

		expect(getAssistantPayload(mockState.payloads[1])?.reasoning_details).toEqual(
			withoutStreamingIndex(expectedReasoningDetails),
		);
	});

	// senpi#2122: a gateway rejects a replayed entry that still carries the streaming
	// artifact with `the reasoning_details at position N entry 0 must not contain
	// streaming index`, and the rejection repeats for every later request because the
	// offending bytes live in stored history.
	it("strips the streaming index from replayed reasoning_details while keeping the stored signature intact", async () => {
		mockState.chunkSets = [
			[
				chunk({ reasoning_details: [signedReasoningTextDetail] }),
				chunk({ reasoning_details: [reasoningSummaryDetail] }),
				toolCallChunk(),
				chunk({}, "tool_calls"),
			],
			[chunk({ content: "ok" }), chunk({}, "stop")],
		];

		const assistantMessage = await runOpenAICompletionsStream();
		const thinking = assistantMessage.content.find((block) => block.type === "thinking");
		if (thinking?.type !== "thinking") throw new Error("Expected thinking block");
		// The persisted signature is untouched, so no on-disk migration is needed.
		expect(thinking.thinkingSignature).toContain('"index"');

		await runOpenAICompletionsStream([assistantMessage]);

		const replayed = getAssistantPayload(mockState.payloads[1])?.reasoning_details;
		expect(replayed).toEqual([
			{
				type: "reasoning.text",
				text: signedReasoningTextDetail.text,
				signature: signedReasoningTextDetail.signature,
				id: signedReasoningTextDetail.id,
				format: signedReasoningTextDetail.format,
			},
			{
				type: "reasoning.summary",
				summary: reasoningSummaryDetail.summary,
				id: reasoningSummaryDetail.id,
				format: reasoningSummaryDetail.format,
			},
		]);
		expect(JSON.stringify(replayed)).not.toContain('"index"');
	});

	it("does not name an assistant property after the serialized reasoning_details", async () => {
		// The thinking block's signature slot is overloaded: it holds either the name of the
		// reasoning field to replay or serialized reasoning_details. Treating the latter as a
		// field name grew a property whose KEY was the whole reasoning array, duplicating the
		// reasoning into every later request (senpi#2122).
		mockState.chunkSets = [
			[
				chunk({ reasoning: signedReasoningTextDetail.text, reasoning_details: [signedReasoningTextDetail] }),
				toolCallChunk(),
				chunk({}, "tool_calls"),
			],
			[chunk({ content: "ok" }), chunk({}, "stop")],
		];

		const assistantMessage = await runOpenAICompletionsStream();
		await runOpenAICompletionsStream([assistantMessage]);

		const messages = (mockState.payloads[1] as { messages: Array<Record<string, unknown>> }).messages;
		const replayedAssistant = messages.find((message) => message.role === "assistant");
		expect(Object.keys(replayedAssistant ?? {}).sort()).toEqual([
			"content",
			"reasoning_details",
			"role",
			"tool_calls",
		]);
	});

	it("replays a stored signature that already contains the streaming index without it", async () => {
		// Shape of an assistant block persisted by an earlier build: the merged array was
		// serialized verbatim, streaming `index` included. Such sessions must recover on
		// the next request instead of 400ing forever.
		const storedSignature = JSON.stringify([
			{
				type: "reasoning.text",
				text: "Checking the stored plan before answering.",
				signature: "sha256:stored-text-signature",
				id: "reasoning-stored-1",
				format: "anthropic-claude-v1",
				index: 0,
			},
			{ type: "reasoning.encrypted", id: "reasoning-stored-2", data: "stored-encrypted-blob", index: 1 },
			{
				type: "reasoning.summary",
				summary: "Answered from the stored plan.",
				id: "reasoning-stored-3",
				format: "anthropic-claude-v1",
				index: 2,
			},
		]);
		const storedAssistantMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "Checking the stored plan before answering.",
					thinkingSignature: storedSignature,
				},
				{ type: "toolCall", id: "call_stored_1", name: "read", arguments: { path: "README.md" } },
			],
			api: "openai-completions",
			provider: "openrouter",
			model: "google/gemini-test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		mockState.chunkSets = [[chunk({ content: "ok" }), chunk({}, "stop")]];

		await runOpenAICompletionsStream([storedAssistantMessage]);

		const replayed = getAssistantPayload(mockState.payloads[0])?.reasoning_details;
		expect(replayed).toEqual([
			{
				type: "reasoning.text",
				text: "Checking the stored plan before answering.",
				signature: "sha256:stored-text-signature",
				id: "reasoning-stored-1",
				format: "anthropic-claude-v1",
			},
			{ type: "reasoning.encrypted", id: "reasoning-stored-2", data: "stored-encrypted-blob" },
			{
				type: "reasoning.summary",
				summary: "Answered from the stored plan.",
				id: "reasoning-stored-3",
				format: "anthropic-claude-v1",
			},
		]);
		expect(JSON.stringify(replayed)).not.toContain('"index"');
	});

	// senpi#2125: the defect class behind #2122 is not the name `index`. A stored entry is an
	// open record, so any key a provider streams — or a future build persists — is echoed back
	// to the provider. The replay must be BUILT from the input schema, not filtered by name.
	it("replays only the fields the input schema defines, dropping unknown keys", async () => {
		const storedSignature = JSON.stringify([
			{
				type: "reasoning.text",
				text: "Plan the edit before touching the file.",
				signature: "sha256:stored-text",
				id: "reasoning-1",
				format: "anthropic-claude-v1",
				index: 0,
				chunk_ordinal: 7,
				delta_id: "delta-abc",
			},
			{
				type: "reasoning.summary",
				summary: "Edited the file.",
				id: "reasoning-2",
				index: 1,
				streaming_state: { open: false },
			},
		]);

		await replayStoredThinking(storedSignature);

		const replayed = getAssistantPayload(mockState.payloads[0])?.reasoning_details;
		expect(replayed).toEqual([
			{
				type: "reasoning.text",
				id: "reasoning-1",
				format: "anthropic-claude-v1",
				text: "Plan the edit before touching the file.",
				signature: "sha256:stored-text",
			},
			{ type: "reasoning.summary", id: "reasoning-2", summary: "Edited the file." },
		]);
		const serialized = JSON.stringify(replayed);
		for (const key of ['"index"', '"chunk_ordinal"', '"delta_id"', '"streaming_state"']) {
			expect(serialized, key).not.toContain(key);
		}
	});

	it("projects all three detail types and keeps the nulls the schema allows", async () => {
		const storedSignature = JSON.stringify([
			{ type: "reasoning.text", text: "Unsigned thought.", signature: null, id: null, index: 0 },
			{ type: "reasoning.encrypted", id: "reasoning-enc", data: "opaque-blob", index: 1 },
			{ type: "reasoning.summary", summary: "Done.", format: "openai-responses-v1", index: 2 },
		]);

		await replayStoredThinking(storedSignature);

		expect(getAssistantPayload(mockState.payloads[0])?.reasoning_details).toEqual([
			{ type: "reasoning.text", id: null, text: "Unsigned thought.", signature: null },
			{ type: "reasoning.encrypted", id: "reasoning-enc", data: "opaque-blob" },
			{ type: "reasoning.summary", format: "openai-responses-v1", summary: "Done." },
		]);
	});

	it("projects the legacy encrypted detail replayed from a tool call signature", async () => {
		mockState.chunkSets = [[chunk({ content: "ok" }), chunk({}, "stop")]];
		const legacyToolCallMessage = storedAssistantMessage([
			{
				type: "toolCall",
				id: "call_legacy",
				name: "read",
				arguments: { path: "README.md" },
				thoughtSignature: JSON.stringify({
					type: "reasoning.encrypted",
					id: "legacy-1",
					data: "legacy-encrypted-blob",
					index: 0,
					chunk_ordinal: 3,
				}),
			},
		]);

		await runOpenAICompletionsStream([legacyToolCallMessage]);

		const replayed = getAssistantPayload(mockState.payloads[0])?.reasoning_details;
		expect(replayed).toEqual([{ type: "reasoning.encrypted", id: "legacy-1", data: "legacy-encrypted-blob" }]);
		expect(JSON.stringify(replayed)).not.toContain('"chunk_ordinal"');
	});
});
