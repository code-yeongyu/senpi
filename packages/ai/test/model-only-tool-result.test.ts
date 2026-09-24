import { create, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it, vi } from "vitest";
import { stream as anthropic } from "../src/api/anthropic-messages.ts";
import { stream as azure } from "../src/api/azure-openai-responses.ts";
import { stream as bedrock } from "../src/api/bedrock-converse-stream.ts";
import {
	buildPiBashResult,
	buildPiEditResult,
	buildPiFindResult,
	buildPiGrepResult,
	buildPiLsResult,
	buildPiReadResult,
	buildPiWriteResult,
} from "../src/api/cursor-agent/exec-modern.ts";
import { ExecClientMessageSchema } from "../src/api/cursor-agent/gen/agent_pb.ts";
import { buildCursorHistoryForTest } from "../src/api/cursor-agent.ts";
import { GetChatMessageRequestSchema } from "../src/api/devin-agent/gen/cascade_pb.ts";
import { buildDevinChatRequest } from "../src/api/devin-agent/request.ts";
import { stream as google } from "../src/api/google-generative-ai.ts";
import { stream as vertex } from "../src/api/google-vertex.ts";
import { stream as mistral } from "../src/api/mistral-conversations.ts";
import { stream as codex } from "../src/api/openai-codex-responses.ts";
import { stream as completions } from "../src/api/openai-completions.ts";
import { stream as responses } from "../src/api/openai-responses.ts";
import { stream as piMessages } from "../src/api/pi-messages.ts";
import { fauxAssistantMessage, fauxToolCall } from "../src/providers/faux.ts";
import type { Api, Context, Model, TextContent, ToolResultMessage } from "../src/types.ts";

const notice = "MODEL_ONLY_SENTINEL \r\n UTF-8: \uD55C\uAE00 \uD83D\uDC08\n";
const captureStop = "model-only-payload-captured";

function model<T extends Api>(api: T): Model<T> {
	return {
		id: "qa-model",
		name: "QA model",
		api,
		provider: "qa",
		baseUrl: "https://example.invalid/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function toolResult(marked: boolean, images = false): ToolResultMessage {
	const footer: TextContent = { type: "text", text: notice, textSignature: "fixture-signature" };
	if (marked) footer.audience = "model";
	return {
		role: "toolResult",
		toolCallId: "call_read",
		toolName: "read",
		content: [
			{ type: "text", text: "visible body\n" },
			footer,
			...(images ? [{ type: "image" as const, mimeType: "image/png", data: "AAAA" }] : []),
		],
		isError: false,
		timestamp: 0,
	};
}

function context(marked: boolean, images: boolean): Context {
	return {
		messages: [
			{ role: "user", content: "Read the fixture", timestamp: 0 },
			fauxAssistantMessage([fauxToolCall("read", {}, { id: "call_read" })], {
				stopReason: "toolUse",
				timestamp: 0,
			}),
			toolResult(marked, images),
		],
	};
}

type Capture = (payload: unknown) => never;
const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "qa" } })).toString("base64url")}.signature`;
const adapters = [
	{
		name: "anthropic-messages",
		run: (ctx: Context, onPayload: Capture) =>
			anthropic(model("anthropic-messages"), ctx, { apiKey: "qa-key", onPayload }).result(),
	},
	{
		name: "openai-completions",
		run: (ctx: Context, onPayload: Capture) =>
			completions(model("openai-completions"), ctx, { apiKey: "qa-key", onPayload }).result(),
	},
	{
		name: "openai-responses/shared",
		run: (ctx: Context, onPayload: Capture) =>
			responses(model("openai-responses"), ctx, { apiKey: "qa-key", onPayload }).result(),
	},
	{
		name: "azure-openai-responses/shared",
		run: (ctx: Context, onPayload: Capture) =>
			azure(model("azure-openai-responses"), ctx, { apiKey: "qa-key", onPayload }).result(),
	},
	{
		name: "openai-codex-responses/shared",
		run: (ctx: Context, onPayload: Capture) =>
			codex(model("openai-codex-responses"), ctx, { apiKey: token, onPayload }).result(),
	},
	{
		name: "bedrock-converse-stream",
		run: (ctx: Context, onPayload: Capture) =>
			bedrock(model("bedrock-converse-stream"), ctx, {
				apiKey: "qa-key",
				region: "us-east-1",
				onPayload,
			}).result(),
	},
	{
		name: "google-generative-ai/shared",
		run: (ctx: Context, onPayload: Capture) =>
			google(model("google-generative-ai"), ctx, { apiKey: "qa-key", onPayload }).result(),
	},
	{
		name: "google-vertex/shared",
		run: (ctx: Context, onPayload: Capture) =>
			vertex(model("google-vertex"), ctx, { apiKey: "qa-key", onPayload }).result(),
	},
	{
		name: "mistral-conversations",
		run: (ctx: Context, onPayload: Capture) =>
			mistral(model("mistral-conversations"), ctx, { apiKey: "qa-key", onPayload }).result(),
	},
	{
		name: "pi-messages",
		run: (ctx: Context, onPayload: Capture) =>
			piMessages(model("pi-messages"), ctx, { apiKey: "qa-key", onPayload }).result(),
	},
];

describe("model-only tool-result wire identity (#2041)", () => {
	for (const adapter of adapters) {
		for (const images of [false, true]) {
			it(`${adapter.name} serializes identical request bytes with images=${images}`, async () => {
				const bodies: string[] = [];
				for (const marked of [false, true]) {
					const input = context(marked, images);
					const original = JSON.stringify(input);
					const result = await adapter.run(input, (payload) => {
						bodies.push(JSON.stringify(payload));
						throw new Error(captureStop);
					});
					expect(result.errorMessage).toContain(captureStop);
					expect(JSON.stringify(input)).toBe(original);
				}
				expect(bodies).toHaveLength(2);
				expect(bodies[0]).toContain("MODEL_ONLY_SENTINEL");
				expect(bodies[1]).not.toContain('"audience"');
				expect(Buffer.from(bodies[1])).toEqual(Buffer.from(bodies[0]));
			});
		}
	}

	it("Devin serializes identical protobuf request bytes", () => {
		// Execution IDs are intentionally fresh; freeze only that source of entropy.
		const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000000");
		try {
			const requests = [false, true].map((marked) =>
				buildDevinChatRequest({
					model: model("devin-agent"),
					context: context(marked, true),
					apiKey: "qa-key",
					cascadeId: "qa-cascade",
				}),
			);
			expect(requests[1].chatMessagePrompts.at(-1)?.prompt).toContain(notice);
			expect(toBinary(GetChatMessageRequestSchema, requests[1])).toEqual(
				toBinary(GetChatMessageRequestSchema, requests[0]),
			);
		} finally {
			uuid.mockRestore();
		}
	});

	it("Cursor's model-input history blobs serialize identical JSON bytes", () => {
		const bodies = [false, true].map((marked) => {
			const messages = context(marked, true).messages;
			return JSON.stringify(buildCursorHistoryForTest(messages, messages.length).rootPromptMessagesJson);
		});
		expect(bodies[0]).toContain("MODEL_ONLY_SENTINEL");
		expect(bodies[1]).not.toContain('"audience"');
		expect(Buffer.from(bodies[1])).toEqual(Buffer.from(bodies[0]));
	});

	for (const operation of ["read", "bash", "edit", "write", "grep", "find", "ls"] as const) {
		it(`Cursor ${operation} serializes identical protobuf tool-result bytes`, () => {
			const serialize = (marked: boolean) => {
				const result = toolResult(marked, true);
				const builders = {
					read: () => ({ case: "piReadResult" as const, value: buildPiReadResult(result) }),
					bash: () => ({ case: "piBashResult" as const, value: buildPiBashResult(result) }),
					edit: () => ({ case: "piEditResult" as const, value: buildPiEditResult(result) }),
					write: () => ({ case: "piWriteResult" as const, value: buildPiWriteResult(result) }),
					grep: () => ({ case: "piGrepResult" as const, value: buildPiGrepResult(result) }),
					find: () => ({ case: "piFindResult" as const, value: buildPiFindResult(result) }),
					ls: () => ({ case: "piLsResult" as const, value: buildPiLsResult(result) }),
				};
				const message = create(ExecClientMessageSchema, {
					id: 1,
					execId: "qa-exec",
					message: builders[operation](),
				});
				return toBinary(ExecClientMessageSchema, message);
			};
			const unmarked = serialize(false);
			expect(Buffer.from(unmarked).includes(Buffer.from(notice))).toBe(true);
			expect(serialize(true)).toEqual(unmarked);
		});
	}
});
