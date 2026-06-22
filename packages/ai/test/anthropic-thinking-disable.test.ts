import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.ts";
import { streamSimple } from "../src/stream.ts";
import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "../src/types.ts";

interface AnthropicThinkingPayload {
	thinking?: { type: string; budget_tokens?: number; display?: string };
	output_config?: { effort?: string };
}

function makePayloadCaptureContext(): Context {
	return {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	options?: SimpleStreamOptions,
): Promise<AnthropicThinkingPayload> {
	let capturedPayload: AnthropicThinkingPayload | undefined;
	const payloadCaptureModel: Model<"anthropic-messages"> = {
		...model,
		baseUrl: "http://127.0.0.1:9",
	};

	const s = streamSimple(payloadCaptureModel, makePayloadCaptureContext(), {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicThinkingPayload;
			return payload;
		},
	});

	await s.result();

	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}

	return capturedPayload;
}

interface RunResult {
	thinkingEventCount: number;
	thinkingCharCount: number;
	text: string;
	contentTypes: string[];
}

function makeE2EContext(): Context {
	return {
		systemPrompt: "You are a precise assistant. Follow the requested output format exactly.",
		messages: [
			{
				role: "user",
				content:
					"Before replying, carefully solve 36863 * 5279 internally. Then reply with the word pong repeated exactly 40 times, separated by single spaces. Do not add any other text.",
				timestamp: Date.now(),
			},
		],
	};
}

function countPongs(text: string): number {
	return text.match(/\bpong\b/gi)?.length ?? 0;
}

async function runWithoutReasoning(model: Model<"anthropic-messages">): Promise<RunResult> {
	const s = streamSimple(model, makeE2EContext(), {
		temperature: 0,
		maxTokens: 160,
	});

	let thinkingEventCount = 0;
	let thinkingCharCount = 0;

	for await (const event of s) {
		if (event.type === "thinking_start" || event.type === "thinking_end") {
			thinkingEventCount += 1;
		}
		if (event.type === "thinking_delta") {
			thinkingEventCount += 1;
			thinkingCharCount += event.delta.length;
		}
	}

	const response = await s.result();
	expect(response.stopReason, response.errorMessage).toBe("stop");

	const text = response.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();

	return {
		thinkingEventCount,
		thinkingCharCount,
		text,
		contentTypes: response.content.map((block) => block.type),
	};
}

describe("Anthropic thinking disable payload", () => {
	it("sends thinking.type=disabled for budget-based reasoning models when thinking is off", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-sonnet-4-5"));

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});

	it("sends thinking.type=disabled for adaptive reasoning models when thinking is off", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-6"));

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});

	it("sends thinking.type=disabled for Claude Opus 4.8 when thinking is off", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-8"));

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config).toBeUndefined();
	});

	it("omits thinking.type=disabled for Claude Fable 5 when thinking is off", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-fable-5"));

		expect(payload.thinking).toBeUndefined();
		expect(payload.output_config).toBeUndefined();
	});

	it("uses adaptive thinking for Claude Opus 4.8 when reasoning is enabled", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-8"), { reasoning: "high" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "high" });
	});

	it("maps xhigh reasoning to effort=xhigh for Claude Opus 4.8", async () => {
		const payload = await capturePayload(getModel("anthropic", "claude-opus-4-8"), { reasoning: "xhigh" });

		expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload.output_config).toEqual({ effort: "xhigh" });
	});

	it("omits previous assistant thinking blocks from normal Opus 4.6 follow-ups when thinking is off", async () => {
		let capturedPayload: { messages?: Array<{ role: string; content: unknown }> } | undefined;
		const model = {
			...getModel("anthropic", "claude-opus-4-6"),
			baseUrl: "http://127.0.0.1:9",
		};
		const previousAssistant: AssistantMessage = {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-6",
			content: [
				{
					type: "thinking",
					thinking: "prior signed thinking",
					thinkingSignature: "opaque-signature",
				},
				{ type: "text", text: "previous answer" },
			],
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

		const s = streamSimple(
			model,
			{
				messages: [
					{ role: "user", content: "first turn", timestamp: Date.now() },
					previousAssistant,
					{ role: "user", content: "follow-up", timestamp: Date.now() },
				],
			},
			{
				apiKey: "fake-key",
				onPayload: (payload) => {
					capturedPayload = payload as { messages?: Array<{ role: string; content: unknown }> };
					return payload;
				},
			},
		);

		await s.result();

		const assistantMessage = capturedPayload?.messages?.find((message) => message.role === "assistant");
		expect(assistantMessage?.content).toEqual([{ type: "text", text: "previous answer" }]);
	});

	it("preserves previous assistant thinking blocks for tool result follow-ups when thinking is off", async () => {
		let capturedPayload: { messages?: Array<{ role: string; content: unknown }> } | undefined;
		const model = {
			...getModel("anthropic", "claude-opus-4-6"),
			baseUrl: "http://127.0.0.1:9",
		};
		const previousAssistant: AssistantMessage = {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-6",
			content: [
				{
					type: "thinking",
					thinking: "tool-use thinking",
					thinkingSignature: "tool-signature",
				},
				{
					type: "toolCall",
					id: "toolu_123",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};

		const s = streamSimple(
			model,
			{
				messages: [
					{ role: "user", content: "read a file", timestamp: Date.now() },
					previousAssistant,
					{
						role: "toolResult",
						toolCallId: "toolu_123",
						toolName: "read",
						content: [{ type: "text", text: "file contents" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "fake-key",
				onPayload: (payload) => {
					capturedPayload = payload as { messages?: Array<{ role: string; content: unknown }> };
					return payload;
				},
			},
		);

		await s.result();

		const assistantMessage = capturedPayload?.messages?.find((message) => message.role === "assistant");
		expect(assistantMessage?.content).toEqual([
			{ type: "thinking", thinking: "tool-use thinking", signature: "tool-signature" },
			{ type: "tool_use", id: "toolu_123", name: "read", input: { path: "README.md" } },
		]);
	});

	it("replays signed Anthropic thinking text without rewriting protected content", async () => {
		// given a signed thinking block whose text must stay byte-for-byte tied to its signature
		let capturedPayload: { messages?: Array<{ role: string; content: unknown }> } | undefined;
		const model = {
			...getModel("anthropic", "claude-opus-4-6"),
			baseUrl: "http://127.0.0.1:9",
		};
		const protectedThinking = `tool-use thinking ${String.fromCharCode(0xd83d)}`;
		const previousAssistant: AssistantMessage = {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-6",
			content: [
				{
					type: "thinking",
					thinking: protectedThinking,
					thinkingSignature: "tool-signature",
				},
				{
					type: "toolCall",
					id: "toolu_123",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};

		// when the tool-result follow-up is serialized for Anthropic replay
		const s = streamSimple(
			model,
			{
				messages: [
					{ role: "user", content: "read a file", timestamp: Date.now() },
					previousAssistant,
					{
						role: "toolResult",
						toolCallId: "toolu_123",
						toolName: "read",
						content: [{ type: "text", text: "file contents" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "fake-key",
				onPayload: (payload) => {
					capturedPayload = payload as { messages?: Array<{ role: string; content: unknown }> };
					return payload;
				},
			},
		);

		await s.result();

		// then the protected thinking payload is not normalized, trimmed, or otherwise rewritten
		const assistantMessage = capturedPayload?.messages?.find((message) => message.role === "assistant");
		expect(assistantMessage?.content).toEqual([
			{ type: "thinking", thinking: protectedThinking, signature: "tool-signature" },
			{ type: "tool_use", id: "toolu_123", name: "read", input: { path: "README.md" } },
		]);
	});

	it("preserves previous assistant redacted thinking blocks for tool result follow-ups when thinking is off", async () => {
		// given an opaque redacted thinking block from the same Anthropic model
		let capturedPayload: { messages?: Array<{ role: string; content: unknown }> } | undefined;
		const model = {
			...getModel("anthropic", "claude-opus-4-6"),
			baseUrl: "http://127.0.0.1:9",
		};
		const previousAssistant: AssistantMessage = {
			role: "assistant",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-4-6",
			content: [
				{
					type: "thinking",
					thinking: "[Reasoning redacted]",
					thinkingSignature: "opaque-redacted-payload",
					redacted: true,
				},
				{
					type: "toolCall",
					id: "toolu_123",
					name: "read",
					arguments: { path: "README.md" },
				},
			],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};

		// when the tool-result follow-up is serialized
		const s = streamSimple(
			model,
			{
				messages: [
					{ role: "user", content: "read a file", timestamp: Date.now() },
					previousAssistant,
					{
						role: "toolResult",
						toolCallId: "toolu_123",
						toolName: "read",
						content: [{ type: "text", text: "file contents" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: "fake-key",
				onPayload: (payload) => {
					capturedPayload = payload as { messages?: Array<{ role: string; content: unknown }> };
					return payload;
				},
			},
		);

		await s.result();

		// then the opaque redacted payload is replayed before its matching tool_use without cache metadata
		const assistantMessage = capturedPayload?.messages?.find((message) => message.role === "assistant");
		expect(assistantMessage?.content).toEqual([
			{ type: "redacted_thinking", data: "opaque-redacted-payload" },
			{ type: "tool_use", id: "toolu_123", name: "read", input: { path: "README.md" } },
		]);
	});
});

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic thinking disable E2E", () => {
	it("disables thinking for Claude reasoning models", { retry: 2, timeout: 30000 }, async () => {
		const result = await runWithoutReasoning(getModel("anthropic", "claude-sonnet-4-5"));

		expect(result.thinkingEventCount).toBe(0);
		expect(result.thinkingCharCount).toBe(0);
		expect(result.contentTypes).not.toContain("thinking");
		expect(countPongs(result.text)).toBeGreaterThanOrEqual(35);
	});
});
