import { describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import type { AssistantMessage, Context, Model, SimpleStreamOptions, ToolResultMessage, Usage } from "../src/types.ts";

interface AnthropicPayload {
	thinking?: { type: string };
	output_config?: { effort?: string };
	messages: Array<{
		role: string;
		content: Array<{ type: string; id?: string }> | string;
	}>;
}

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function foreignToolTurn(toolCalls: Array<{ id: string; name: string }>): {
	assistant: AssistantMessage;
	results: ToolResultMessage[];
} {
	const assistant: AssistantMessage = {
		role: "assistant",
		content: toolCalls.map((call) => ({
			type: "toolCall" as const,
			id: call.id,
			name: call.name,
			arguments: {},
		})),
		api: "openai-completions",
		provider: "moonshot",
		model: "kimi-k2-6",
		usage,
		stopReason: "toolUse",
		timestamp: Date.now() - 2000,
	};
	const results: ToolResultMessage[] = toolCalls.map((call) => ({
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: Date.now() - 1000,
	}));
	return { assistant, results };
}

async function capturePayload(
	model: Model<"anthropic-messages">,
	context: Context,
	options?: SimpleStreamOptions,
): Promise<AnthropicPayload> {
	let capturedPayload: AnthropicPayload | undefined;
	const s = streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" }, context, {
		...options,
		apiKey: "fake-key",
		onPayload: (payload) => {
			capturedPayload = payload as AnthropicPayload;
			return payload;
		},
	} as SimpleStreamOptions);
	await s.result();
	if (!capturedPayload) {
		throw new Error("Expected payload to be captured before request failure");
	}
	return capturedPayload;
}

function assistantBlocks(payload: AnthropicPayload): Array<{ type: string; id?: string }> {
	const assistant = payload.messages.filter((message) => message.role === "assistant").at(-1);
	if (!assistant || !Array.isArray(assistant.content)) {
		throw new Error("Expected an assistant message with block content in the payload");
	}
	return assistant.content;
}

describe("Anthropic cross-model history hardening", () => {
	const model = getModel("anthropic", "claude-sonnet-4-5");

	it("never collides when truncating long foreign tool call ids", async () => {
		const sharedPrefix = `call_${"A".repeat(200)}`;
		const { assistant, results } = foreignToolTurn([
			{ id: `${sharedPrefix}1111`, name: "bash" },
			{ id: `${sharedPrefix}2222`, name: "read" },
		]);
		const context: Context = {
			messages: [{ role: "user", content: "run tools", timestamp: Date.now() - 3000 }, assistant, ...results],
		};

		const payload = await capturePayload(model, context);

		const toolUseIds = assistantBlocks(payload)
			.filter((block) => block.type === "tool_use")
			.map((block) => block.id ?? "");
		expect(toolUseIds).toHaveLength(2);
		expect(new Set(toolUseIds).size).toBe(2);
		for (const id of toolUseIds) {
			expect(id.length).toBeLessThanOrEqual(64);
			expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
		}
	});

	it("degrades thinking when the final assistant tool turn lost its signed thinking", async () => {
		const { assistant, results } = foreignToolTurn([{ id: "call_abc", name: "bash" }]);
		const context: Context = {
			messages: [{ role: "user", content: "run tools", timestamp: Date.now() - 3000 }, assistant, ...results],
		};

		const payload = await capturePayload(model, context, { reasoning: "high" });

		expect(payload.thinking?.type).toBe("disabled");
	});

	it("degrades thinking when replaying a Codex reasoning tool turn", async () => {
		const { assistant, results } = foreignToolTurn([{ id: "call_codex", name: "bash" }]);
		const codexAssistant: AssistantMessage = {
			...assistant,
			api: "openai-responses",
			provider: "openai-codex",
			model: "gpt-5.5",
			content: [
				{
					type: "thinking",
					thinking: "inspect the repository",
					thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_codex", summary: [] }),
				},
				...assistant.content,
			],
		};
		const context: Context = {
			messages: [{ role: "user", content: "run tools", timestamp: Date.now() - 3000 }, codexAssistant, ...results],
		};

		const payload = await capturePayload(model, context, { reasoning: "high" });

		expect(payload.thinking?.type).toBe("disabled");
		expect(assistantBlocks(payload).some((block) => block.type === "thinking")).toBe(false);
	});

	it("degrades to the lowest legal effort when thinking cannot be disabled", async () => {
		// Claude Fable 5 rejects `thinking.type: "disabled"` outright, so a replayed
		// foreign tool turn must fall back to the cheapest legal effort instead of
		// failing every turn with a 400.
		const fable = getModel("anthropic", "claude-fable-5");
		const { assistant, results } = foreignToolTurn([{ id: "call_abc", name: "bash" }]);
		const context: Context = {
			messages: [{ role: "user", content: "run tools", timestamp: Date.now() - 3000 }, assistant, ...results],
		};

		const payload = await capturePayload(fable, context, { reasoning: "high" });

		expect(payload.thinking).toBeUndefined();
		expect(payload.output_config).toEqual({ effort: "low" });
	});

	it("keeps thinking enabled when the final turn does not require replayed thinking", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};

		const payload = await capturePayload(model, context, { reasoning: "high" });

		expect(payload.thinking).toBeDefined();
		expect(payload.thinking?.type).not.toBe("disabled");
	});
});
