import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentLoopConfig, AgentTool } from "../src/types.ts";

type SuccessfulAssistantMessage = AssistantMessage & {
	stopReason: Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse">;
};

class AssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor(message: SuccessfulAssistantMessage) {
		super(
			(event) => event.type === "done",
			(event) => {
				if (event.type !== "done") throw new Error("Unexpected non-terminal assistant event");
				return event.message;
			},
		);
		queueMicrotask(() => this.push({ type: "done", reason: message.stopReason, message }));
	}
}

function model(): Model<"openai-responses"> {
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

function assistant(
	content: AssistantMessage["content"],
	stopReason: SuccessfulAssistantMessage["stopReason"],
): SuccessfulAssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 0,
	};
}

function config(resolveUnknownToolCall: AgentLoopConfig["resolveUnknownToolCall"]): AgentLoopConfig {
	return {
		model: model(),
		convertToLlm: (messages) => messages.filter((message): message is Message => "role" in message),
		resolveUnknownToolCall,
	};
}

async function run(resolveUnknownToolCall: AgentLoopConfig["resolveUnknownToolCall"]) {
	const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
	let request = 0;
	const stream = agentLoop(
		[{ role: "user", content: "call it", timestamp: 0 }],
		context,
		config(resolveUnknownToolCall),
		undefined,
		() =>
			new AssistantStream(
				request++ === 0
					? assistant(
							[{ type: "toolCall", id: "call-1", name: "lazy_weather", arguments: { city: "Seoul" } }],
							"toolUse",
						)
					: assistant([{ type: "text", text: "done" }], "stop"),
			),
	);
	for await (const _event of stream) {
		// consume
	}
	return await stream.result();
}

const ToolParameters = Type.Object({ city: Type.String() });

function tool(execute = vi.fn()): AgentTool<typeof ToolParameters> {
	return {
		name: "lazy_weather",
		label: "Lazy weather",
		description: "Weather",
		parameters: ToolParameters,
		execute: async (_id, params) => {
			execute(params);
			return { content: [{ type: "text", text: `weather:${params.city}` }], details: {} };
		},
	};
}

describe("resolveUnknownToolCall", () => {
	it("consults the resolver and executes the returned activated tool", async () => {
		const execute = vi.fn();
		const activated = tool(execute);
		const resolver = vi.fn(async (name: string) => (name === "lazy_weather" ? activated : undefined));

		const messages = await run(resolver);

		expect(resolver).toHaveBeenCalledWith("lazy_weather", expect.objectContaining({ tools: [] }));
		expect(execute).toHaveBeenCalledWith({ city: "Seoul" });
		expect(messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "toolResult",
					isError: false,
					content: [{ type: "text", text: "weather:Seoul" }],
				}),
			]),
		);
	});

	it("keeps the existing unknown-tool error when the resolver returns undefined", async () => {
		const resolver = vi.fn(async () => undefined);

		const messages = await run(resolver);

		expect(resolver).toHaveBeenCalledOnce();
		expect(messages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: "toolResult",
					isError: true,
					content: [{ type: "text", text: "Tool lazy_weather not found" }],
				}),
			]),
		);
	});
});
