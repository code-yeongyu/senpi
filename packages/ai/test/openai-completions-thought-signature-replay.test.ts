import { Type } from "typebox";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamOpenAICompletions } from "../src/api/openai-completions.ts";
import type { AssistantMessage, Message, Model, Tool, ToolCall } from "../src/types.ts";
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
							for (const chunk of chunks) yield chunk;
						},
					};
					const result = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{ data: typeof stream; response: { status: number; headers: Headers } }>;
					};
					result.withResponse = async () => ({ data: stream, response: { status: 200, headers: new Headers() } });
					return result;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

const SIGNATURE = "CiQBjz1rX+5uQ/dGhvdWdodC1zaWduYXR1cmUtYnl0ZXM=AY89a18W/ww5uxmq7+Zz==";
const PROXY_TOOL_CALL_ID = `call_6550884__thought__${SIGNATURE}`;
const readTool: Tool = { name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) };

function proxyModel(id = "vertex_ai/gemini-test"): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "litellm",
		baseUrl: "http://localhost:4000/v1",
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
		model: "vertex_ai/gemini-test",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	};
}

function signedToolCallChunks(): unknown[] {
	return [
		chunk({
			tool_calls: [
				{
					index: 0,
					id: PROXY_TOOL_CALL_ID,
					type: "function",
					function: { name: "read", arguments: "" },
					provider_specific_fields: { thought_signature: SIGNATURE },
				},
			],
		}),
		chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt"}' } }] }),
		chunk({}, "tool_calls"),
	];
}

async function run(model: Model<"openai-completions">, messages: Message[]): Promise<AssistantMessage> {
	return await streamOpenAICompletions(model, normalizeContext({ messages, tools: [readTool] }), {
		apiKey: "test",
	}).result();
}

type ReplayedToolCall = { id?: string; provider_specific_fields?: { thought_signature?: unknown } };
type ReplayedMessage = { role?: string; tool_calls?: ReplayedToolCall[]; tool_call_id?: string };

function replayedMessages(payload: unknown): ReplayedMessage[] {
	return (payload as { messages?: ReplayedMessage[] }).messages ?? [];
}

async function followUpPayload(firstTurn: AssistantMessage): Promise<unknown> {
	const toolCall = firstTurn.content.find((block): block is ToolCall => block.type === "toolCall");
	mockState.chunkSets = [[chunk({ content: "done" }), chunk({}, "stop")]];
	await run(proxyModel(), [
		{ role: "user", content: "read a.txt", timestamp: 1 },
		firstTurn,
		{
			role: "toolResult",
			toolCallId: toolCall?.id ?? "",
			toolName: "read",
			content: [{ type: "text", text: "alpha" }],
			isError: false,
			timestamp: 2,
		},
	]);
	return mockState.payloads.at(-1);
}

beforeEach(() => {
	mockState.chunkSets = [];
	mockState.payloads = [];
});

describe("openai-completions thought signatures carried in provider_specific_fields (#4564)", () => {
	it("keeps a streamed tool call's provider_specific_fields.thought_signature on the tool call", async () => {
		mockState.chunkSets = [signedToolCallChunks()];

		const message = await run(proxyModel(), [{ role: "user", content: "read a.txt", timestamp: 1 }]);

		const toolCall = message.content.find((block): block is ToolCall => block.type === "toolCall");
		expect(toolCall).toMatchObject({
			id: PROXY_TOOL_CALL_ID,
			thoughtSignature: SIGNATURE,
			arguments: { path: "a.txt" },
		});
	});

	it("sends the signature back on the replayed tool call of the same model", async () => {
		mockState.chunkSets = [signedToolCallChunks()];
		const firstTurn = await run(proxyModel(), [{ role: "user", content: "read a.txt", timestamp: 1 }]);

		const messages = replayedMessages(await followUpPayload(firstTurn));

		const replayedCall = messages.find((message) => message.role === "assistant")?.tool_calls?.[0];
		expect(replayedCall?.provider_specific_fields).toEqual({ thought_signature: SIGNATURE });
		expect(messages.find((message) => message.role === "tool")?.tool_call_id).toBe(replayedCall?.id);
	});

	it("does not send another model's signature", async () => {
		mockState.chunkSets = [signedToolCallChunks()];
		const otherModelTurn = await run(proxyModel("vertex_ai/other-model"), [
			{ role: "user", content: "read a.txt", timestamp: 1 },
		]);

		const messages = replayedMessages(await followUpPayload(otherModelTurn));

		const replayedCall = messages.find((message) => message.role === "assistant")?.tool_calls?.[0];
		expect(replayedCall).toBeDefined();
		expect(replayedCall).not.toHaveProperty("provider_specific_fields");
	});
});
