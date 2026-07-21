import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type ToolCall,
	wrapStreamWithInvokeRecovery,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

type Scenario =
	| "delta-before-start"
	| "end-before-start"
	| "repeated-start"
	| "delta-after-end"
	| "repeated-end"
	| "late-collision";

const toolSchema = Type.Object({ command: Type.String() });
const recoveryTool = { name: "Bash", description: "Run a command", parameters: toolSchema };

function usage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

type NativePartialToolCall = ToolCall & { partialJson: string };

function partialNativeCall(toolCall: ToolCall): NativePartialToolCall {
	return { ...toolCall, partialJson: "" };
}

function assistant(
	content: AssistantMessage["content"] = [],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant" as const,
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "claude-test",
		content,
		usage: usage(),
		stopReason,
		timestamp: 1,
	};
}

function nativeCall(id = "toolu-invalid") {
	return { type: "toolCall" as const, id, name: "Bash", arguments: { command: "echo invalid" } };
}

function createInvalidStream(scenario: Scenario) {
	const inner = createAssistantMessageEventStream();
	const wrapped = wrapStreamWithInvokeRecovery(inner, [recoveryTool]);
	const source = assistant([]);
	inner.push({ type: "start", partial: structuredClone(source) });

	if (scenario === "delta-before-start" || scenario === "end-before-start") {
		source.content.push(
			...Array.from({ length: 7 }, (_, index) => ({
				type: "providerNative" as const,
				subtype: "fixture",
				raw: { index },
			})),
		);
		source.content.push(partialNativeCall(nativeCall()));
		if (scenario === "delta-before-start") {
			inner.push({ type: "toolcall_delta", contentIndex: 7, delta: "{}", partial: structuredClone(source) });
		} else {
			inner.push({
				type: "toolcall_end",
				contentIndex: 7,
				toolCall: nativeCall(),
				partial: structuredClone(source),
			});
		}
	} else if (scenario === "late-collision") {
		source.content.push({ type: "text", text: "" });
		inner.push({ type: "text_start", contentIndex: 0, partial: structuredClone(source) });
		const xml = '<invoke name="Bash"><parameter name="command">echo recovered</parameter></invoke>';
		source.content[0] = { type: "text", text: xml };
		inner.push({ type: "text_delta", contentIndex: 0, delta: xml, partial: structuredClone(source) });
		inner.push({ type: "text_end", contentIndex: 0, content: xml, partial: structuredClone(source) });
		source.content.push(partialNativeCall(nativeCall("recovered-antml-0")));
		inner.push({ type: "toolcall_start", contentIndex: 1, partial: structuredClone(source) });
	} else {
		source.content.push(partialNativeCall({ ...nativeCall(), arguments: {} }));
		inner.push({ type: "toolcall_start", contentIndex: 0, partial: structuredClone(source) });
		if (scenario === "repeated-start") {
			inner.push({ type: "toolcall_start", contentIndex: 0, partial: structuredClone(source) });
		} else {
			source.content[0] = nativeCall();
			inner.push({
				type: "toolcall_end",
				contentIndex: 0,
				toolCall: nativeCall(),
				partial: structuredClone(source),
			});
			if (scenario === "delta-after-end") {
				inner.push({ type: "toolcall_delta", contentIndex: 0, delta: "{}", partial: structuredClone(source) });
			} else {
				inner.push({
					type: "toolcall_end",
					contentIndex: 0,
					toolCall: nativeCall(),
					partial: structuredClone(source),
				});
			}
		}
	}
	inner.push({ type: "done", reason: "stop", message: assistant(structuredClone(source.content)) });
	return wrapped;
}

function createModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-test",
		name: "Claude Test",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
}

function isLlmMessage(message: AgentMessage): message is Message {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

async function collectWithTimeout(stream: ReturnType<typeof agentLoop>) {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			(async () => {
				const events: AgentEvent[] = [];
				for await (const event of stream) events.push(event);
				return { events, messages: await stream.result() };
			})(),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error("agentLoop invalid-order probe did not terminate")), 500);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

it("prevents agent-loop execution for invalid native order and late collision", async () => {
	for (const scenario of [
		"delta-before-start",
		"end-before-start",
		"repeated-start",
		"delta-after-end",
		"repeated-end",
		"late-collision",
	] satisfies Scenario[]) {
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "executed" }], details: {} }));
		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "Bash",
			label: "Bash",
			description: "Run a command",
			parameters: toolSchema,
			execute,
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: (messages) => messages.filter(isLlmMessage),
		};
		let streamCalls = 0;
		const stream = agentLoop([{ role: "user", content: scenario, timestamp: 1 }], context, config, undefined, () => {
			streamCalls += 1;
			return createInvalidStream(scenario);
		});
		const { events, messages } = await collectWithTimeout(stream);
		const finalAssistant = messages.findLast((message) => message.role === "assistant");

		expect(execute, scenario).not.toHaveBeenCalled();
		expect(streamCalls, scenario).toBe(1);
		expect(
			events.some((event) => event.type.startsWith("tool_execution_")),
			scenario,
		).toBe(false);
		expect(finalAssistant, scenario).toMatchObject({ stopReason: "error" });
		if (finalAssistant?.role === "assistant") {
			expect(
				finalAssistant.content.filter((block) => block.type === "toolCall"),
				scenario,
			).toEqual([]);
		}
	}
});
