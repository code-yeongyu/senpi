import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

/**
 * A tool may report a failure WITHOUT throwing by setting `isError: true` on the
 * result it returns, keeping its structured `details` intact for the model to
 * branch on (omo's team/memory tools and the terminal tool do this). The loop
 * must carry that flag into `tool_execution_end` and the `toolResult` message,
 * because every downstream error surface keys on it: the TUI's tool-row
 * background, the RPC `isError` field the desktop GUI maps to "failed", and
 * `tool_result` extension hooks.
 */

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function isLlmMessage(message: AgentMessage): message is Message {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

type ToolExecutionEndEvent = Extract<AgentEvent, { type: "tool_execution_end" }>;
type ToolResultStartEvent = Extract<AgentEvent, { type: "message_start" }> & {
	message: { role: "toolResult"; isError: boolean };
};

async function runSingleToolCall(tool: AgentTool<ReturnType<typeof Type.Object>, unknown>) {
	const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
	const config: AgentLoopConfig = { model: createModel(), convertToLlm: (messages) => messages.filter(isLlmMessage) };
	let llmCalls = 0;
	const events: AgentEvent[] = [];
	const stream = agentLoop([createUserMessage("go")], context, config, undefined, () => {
		llmCalls++;
		const mockStream = new MockAssistantStream();
		queueMicrotask(() => {
			mockStream.push({
				type: "done",
				reason: llmCalls === 1 ? "toolUse" : "stop",
				message:
					llmCalls === 1
						? createAssistantMessage(
								[{ type: "toolCall", id: "tool-1", name: tool.name, arguments: {} }],
								"toolUse",
							)
						: createAssistantMessage([{ type: "text", text: "done" }], "stop"),
			});
		});
		return mockStream;
	});
	for await (const event of stream) events.push(event);

	const end = events.find((event): event is ToolExecutionEndEvent => event.type === "tool_execution_end");
	const toolResult = events.find(
		(event): event is ToolResultStartEvent => event.type === "message_start" && event.message.role === "toolResult",
	);
	if (!end || !toolResult) throw new Error("tool call did not complete");
	return { end, toolResult };
}

function createTool(name: string, result: Record<string, unknown>): AgentTool<ReturnType<typeof Type.Object>, unknown> {
	return {
		name,
		label: name,
		description: `returns ${JSON.stringify(result)}`,
		parameters: Type.Object({}),
		async execute() {
			return result as never;
		},
	};
}

describe("inline tool result isError", () => {
	it("marks a result returned with isError: true as a tool error without discarding its details", async () => {
		const { end, toolResult } = await runSingleToolCall(
			createTool("inline_fail", {
				content: [{ type: "text", text: "member 'x' failed to start" }],
				details: { kind: "runtime_error" },
				isError: true,
			}),
		);

		expect(end.isError).toBe(true);
		expect(end.result.details).toEqual({ kind: "runtime_error" });
		expect(toolResult.message.isError).toBe(true);
	});

	it("keeps a result without an isError flag as a successful tool result", async () => {
		const { end, toolResult } = await runSingleToolCall(
			createTool("plain_ok", { content: [{ type: "text", text: "ok" }], details: { kind: "created" } }),
		);

		expect(end.isError).toBe(false);
		expect(toolResult.message.isError).toBe(false);
	});

	it("treats an explicit isError: false as success", async () => {
		const { end } = await runSingleToolCall(
			createTool("explicit_ok", { content: [{ type: "text", text: "ok" }], details: {}, isError: false }),
		);

		expect(end.isError).toBe(false);
	});
});
