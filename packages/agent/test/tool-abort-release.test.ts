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
 * Aborting a run must release the agent loop even when the executing tool
 * ignores its abort signal and never settles.
 *
 * `executePreparedToolCall` awaits the tool's own promise, so a tool that never
 * resolves and never observes `signal` pins that await forever: the run never
 * reaches `agent_end`, the session never goes idle, the session work barrier
 * stays held, and queued prompts park behind it. In the TUI that is the
 * "Running <tool> (25m - esc to interrupt)" hang where ESC does nothing.
 *
 * The provider stream already races its reads against abort; tool execution did
 * not. This pins the tool-agnostic form of the bash-specific hang fixed by
 * "release aborted bash promptly when killed descendants hold stdio".
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

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(isLlmMessage);
}

describe("tool abort release", () => {
	it("ends the run when an aborted tool ignores its signal and never settles", async () => {
		const toolSchema = Type.Object({});
		const controller = new AbortController();
		let toolStarted = false;
		let announceToolEntered: (() => void) | undefined;
		const toolEntered = new Promise<void>((resolve) => {
			announceToolEntered = resolve;
		});

		const stuckTool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "stuck",
			label: "Stuck",
			description: "Never settles and ignores its abort signal",
			parameters: toolSchema,
			async execute() {
				toolStarted = true;
				announceToolEntered?.();
				return await new Promise<never>(() => {});
			},
		};

		const context: AgentContext = { systemPrompt: "", messages: [], tools: [stuckTool] };
		const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };

		let llmCalls = 0;
		const events: AgentEvent[] = [];
		const stream = agentLoop([createUserMessage("start")], context, config, controller.signal, () => {
			llmCalls++;
			const mockStream = new MockAssistantStream();
			queueMicrotask(() => {
				mockStream.push({
					type: "done",
					reason: "toolUse",
					message: createAssistantMessage(
						[{ type: "toolCall", id: "tool-1", name: "stuck", arguments: {} }],
						"toolUse",
					),
				});
			});
			return mockStream;
		});

		const drain = (async () => {
			for await (const event of stream) {
				events.push(event);
			}
		})();

		await toolEntered;
		controller.abort();

		const settled = await Promise.race([
			drain.then(() => "settled" as const),
			new Promise<"hung">((resolve) => {
				setTimeout(() => resolve("hung"), 2_000);
			}),
		]);

		expect(toolStarted).toBe(true);
		expect(llmCalls).toBe(1);
		expect(settled).toBe("settled");
		expect(events.filter((event) => event.type === "agent_end")).toHaveLength(1);
	});
});
