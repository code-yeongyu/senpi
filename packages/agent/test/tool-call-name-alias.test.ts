import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type ToolResultMessage,
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

const ToolParameters = Type.Object({ city: Type.String() });

function weatherTool(name: string, execute = vi.fn()): AgentTool<typeof ToolParameters> {
	return {
		name,
		label: name,
		description: "Weather",
		parameters: ToolParameters,
		execute: async (_id, params) => {
			execute(params);
			return { content: [{ type: "text", text: `${name}:${params.city}` }], details: {} };
		},
	};
}

async function callOnce(
	calledName: string,
	tools: AgentTool[],
	overrides: Partial<AgentLoopConfig> = {},
): Promise<{ result: ToolResultMessage; startToolNames: string[]; endToolNames: string[] }> {
	const context: AgentContext = { systemPrompt: "", messages: [], tools };
	let request = 0;
	const stream = agentLoop(
		[{ role: "user", content: "call it", timestamp: 0 }],
		context,
		{
			model: model(),
			convertToLlm: (messages) => messages.filter((message): message is Message => "role" in message),
			...overrides,
		},
		undefined,
		() =>
			new AssistantStream(
				request++ === 0
					? assistant(
							[{ type: "toolCall", id: "call-1", name: calledName, arguments: { city: "Seoul" } }],
							"toolUse",
						)
					: assistant([{ type: "text", text: "done" }], "stop"),
			),
	);
	const startToolNames: string[] = [];
	const endToolNames: string[] = [];
	for await (const event of stream) {
		if (event.type === "tool_execution_start") startToolNames.push(event.toolName);
		if (event.type === "tool_execution_end") endToolNames.push(event.toolName);
	}
	const messages = await stream.result();
	const result = messages.find((message): message is ToolResultMessage => message.role === "toolResult");
	if (!result) throw new Error("expected a tool result");
	return { result, startToolNames, endToolNames };
}

function textOf(result: ToolResultMessage): string {
	return result.content.map((block) => (block.type === "text" ? block.text : `[${block.type}]`)).join("\n");
}

describe("tool-call name alias resolution", () => {
	it("runs the unique active tool for a gateway-namespaced, recased name and reports the correction", async () => {
		// given: the model saw the tool as mcp__686f__LazyWeather on a gateway path
		const execute = vi.fn();
		const seenByHook: string[] = [];

		// when
		const { result, startToolNames, endToolNames } = await callOnce(
			"mcp__686f__LazyWeather",
			[weatherTool("lazy_weather", execute)],
			{
				beforeToolCall: async ({ toolCall }) => {
					seenByHook.push(toolCall.name);
					return undefined;
				},
			},
		);

		// then
		expect(execute).toHaveBeenCalledWith({ city: "Seoul" });
		expect(result.isError).toBe(false);
		expect(result.toolName).toBe("lazy_weather");
		expect(seenByHook).toEqual(["lazy_weather"]);
		expect(startToolNames).toEqual(["lazy_weather"]);
		expect(endToolNames).toEqual(["lazy_weather"]);
		expect(result.content[0]).toEqual({
			type: "text",
			text: '[auto-corrected] no tool is named "mcp__686f__LazyWeather"; ran "lazy_weather". Call tools by their exact listed name.',
			audience: "model",
		});
		expect(textOf(result)).toContain("lazy_weather:Seoul");
	});

	it("resolves a bare snake_case name that only differs by the gateway namespace", async () => {
		const execute = vi.fn();

		const { result } = await callOnce("mcp__686f__lazy_weather", [weatherTool("lazy_weather", execute)]);

		expect(execute).toHaveBeenCalledOnce();
		expect(result.toolName).toBe("lazy_weather");
		expect(result.isError).toBe(false);
	});

	it("never guesses between two tools that fold to the same key", async () => {
		const first = vi.fn();
		const second = vi.fn();

		const { result } = await callOnce("mcp__686f__FooBar", [
			weatherTool("foo_bar", first),
			weatherTool("foo-bar", second),
		]);

		expect(first).not.toHaveBeenCalled();
		expect(second).not.toHaveBeenCalled();
		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe("Tool mcp__686f__FooBar not found");
	});

	it("uses the canonical name of a tool the host resolver activates for a namespaced call", async () => {
		const execute = vi.fn();
		const lazy = weatherTool("lazy_weather", execute);
		const resolver = vi.fn(async (name: string) => (name === "mcp__686f__lazy_weather" ? lazy : undefined));

		const { result, startToolNames, endToolNames } = await callOnce("mcp__686f__lazy_weather", [], {
			resolveUnknownToolCall: resolver,
		});

		expect(resolver).toHaveBeenCalledWith("mcp__686f__lazy_weather", expect.anything());
		expect(execute).toHaveBeenCalledOnce();
		expect(result.toolName).toBe("lazy_weather");
		expect(startToolNames).toEqual(["lazy_weather"]);
		expect(endToolNames).toEqual(["lazy_weather"]);
		expect(textOf(result)).toContain("[auto-corrected]");
	});

	it("leaves exact-name calls untouched", async () => {
		const execute = vi.fn();

		const { result } = await callOnce("lazy_weather", [weatherTool("lazy_weather", execute)]);

		expect(result.toolName).toBe("lazy_weather");
		expect(textOf(result)).toBe("lazy_weather:Seoul");
	});
});
