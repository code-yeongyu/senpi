import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/api/openai-codex-responses.ts";
import type {
	AssistantMessage,
	Context,
	Message,
	Model,
	OpenAIResponsesCompat,
	Tool,
	ToolResultMessage,
} from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

// Ported from the upstream-deleted deferred-tools.test.ts: a tool that a tool result activates through
// `addedToolNames` loads in place on ChatGPT subscription models instead of the top-level `tools` field.

interface CodexPayload {
	tools?: Array<{ name?: string }>;
	input?: Array<{ type?: string; tools?: Array<{ name: string; defer_loading?: boolean }> }>;
}

class PayloadCaptured extends Error {}

function makeTool(name: string): Tool {
	return { name, description: `The ${name} tool`, parameters: Type.Object({ value: Type.String() }) };
}

function makeModel(compat: OpenAIResponsesCompat): Model<"openai-codex-responses"> {
	return {
		id: "gpt-deferred-test",
		name: "GPT Deferred Test",
		api: "openai-codex-responses",
		provider: "chatgpt-subscription",
		baseUrl: "http://127.0.0.1:9",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
		compat,
	};
}

function makeAssistantToolCall(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "call_1", name: "base_tool", arguments: {} }],
		api: "openai-codex-responses",
		provider: "chatgpt-subscription",
		model: "gpt-deferred-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
}

function makeToolResult(addedToolNames: string[]): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "base_tool",
		content: [{ type: "text", text: "done" }],
		addedToolNames,
		isError: false,
		timestamp: 3,
	};
}

function makeContext(tools: Tool[], leading: Message[] = []): Context {
	return {
		messages: [
			{ role: "user", content: "Hello", timestamp: 1 },
			...leading,
			makeAssistantToolCall(),
			makeToolResult(["late_tool"]),
			{ role: "user", content: "Hello", timestamp: 4 },
		],
		tools,
	};
}

function makeCodexToken(): string {
	return `header.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account" } }))}.signature`;
}

async function capturePayload(model: Model<"openai-codex-responses">, context: Context): Promise<CodexPayload> {
	let captured: CodexPayload | undefined;
	await streamSimple(model, normalizeContext(context), {
		apiKey: makeCodexToken(),
		onPayload: (payload) => {
			captured = payload as CodexPayload;
			throw new PayloadCaptured();
		},
	}).result();
	if (!captured) throw new Error("Expected payload capture");
	return captured;
}

function toolNames(payload: CodexPayload): string[] {
	return (payload.tools ?? []).map((tool) => tool.name ?? "");
}

function loaderItems(payload: CodexPayload, type: string) {
	return (payload.input ?? []).filter((item) => item.type === type);
}

describe("chatgpt-subscription deferred tools", () => {
	const tools = [makeTool("base_tool"), makeTool("late_tool")];

	it("loads an activated tool through additional_tools when the model supports them", async () => {
		const payload = await capturePayload(
			makeModel({ supportsAdditionalTools: true, supportsToolSearch: true }),
			makeContext(tools),
		);

		expect(toolNames(payload)).toEqual(["base_tool"]);
		expect(loaderItems(payload, "additional_tools").map((item) => item.tools?.map((tool) => tool.name))).toEqual([
			["late_tool"],
		]);
		expect(loaderItems(payload, "tool_search_output")).toEqual([]);
	});

	it("loads an activated tool through a client tool search result otherwise", async () => {
		const payload = await capturePayload(makeModel({ supportsToolSearch: true }), makeContext(tools));

		expect(toolNames(payload)).toEqual(["base_tool"]);
		expect(loaderItems(payload, "additional_tools")).toEqual([]);
		expect(loaderItems(payload, "tool_search_output").map((item) => item.tools)).toMatchObject([
			[{ name: "late_tool", defer_loading: true }],
		]);
	});

	it("keeps every tool top-level when the model has no in-place loading", async () => {
		const payload = await capturePayload(makeModel({}), makeContext(tools));

		expect(toolNames(payload)).toEqual(["base_tool", "late_tool"]);
		expect(loaderItems(payload, "additional_tools")).toEqual([]);
		expect(loaderItems(payload, "tool_search_output")).toEqual([]);
	});

	it("loads a tool once when a system message and a tool result both introduce it", async () => {
		const systemAddition: Message = {
			role: "system",
			content: "",
			toolsAdded: [makeTool("late_tool")],
			timestamp: 1,
		};
		const payload = await capturePayload(
			makeModel({ supportsAdditionalTools: true, supportsMidConvoSystemMessages: true }),
			makeContext([makeTool("base_tool")], [systemAddition]),
		);

		expect(toolNames(payload)).toEqual(["base_tool"]);
		expect(loaderItems(payload, "additional_tools").map((item) => item.tools?.map((tool) => tool.name))).toEqual([
			["late_tool"],
		]);
	});
});
