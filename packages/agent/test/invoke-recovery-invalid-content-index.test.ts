import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	wrapStreamWithInvokeRecovery,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

const toolSchema = Type.Object({ command: Type.String() });
const recoveryTool = { name: "Bash", description: "Run a command", parameters: toolSchema };

function assistant(): AssistantMessage {
	return {
		role: "assistant",
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-test",
		content: [],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function invalidIndexStream(contentIndex: number) {
	const inner = createAssistantMessageEventStream();
	const wrapped = wrapStreamWithInvokeRecovery(inner, [recoveryTool]);
	const partial = assistant();
	inner.push({ type: "start", partial });
	inner.push({ type: "toolcall_delta", contentIndex, delta: "{}", partial });
	inner.push({ type: "done", reason: "stop", message: partial });
	return wrapped;
}

function model(): Model<"anthropic-messages"> {
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
				timeout = setTimeout(() => reject(new Error("invalid content-index agent probe did not terminate")), 500);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

it("prevents agent-loop execution for invalid native content indices", async () => {
	for (const [label, contentIndex] of [
		["negative", -1],
		["fractional", 0.5],
		["NaN", Number.NaN],
		["positive infinity", Number.POSITIVE_INFINITY],
		["negative infinity", Number.NEGATIVE_INFINITY],
		["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
		["huge finite", 1_000_000_000],
		["out of range", 0],
	] as const) {
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "executed" }], details: {} }));
		const tool: AgentTool<typeof toolSchema, Record<string, never>> = {
			name: "Bash",
			label: "Bash",
			description: "Run a command",
			parameters: toolSchema,
			execute,
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = { model: model(), convertToLlm: (messages) => messages.filter(isLlmMessage) };
		let streamCalls = 0;
		const stream = agentLoop([{ role: "user", content: label, timestamp: 1 }], context, config, undefined, () => {
			streamCalls += 1;
			return invalidIndexStream(contentIndex);
		});
		const { events, messages } = await collectWithTimeout(stream);
		const finalAssistant = messages.findLast((message) => message.role === "assistant");

		expect(execute, label).not.toHaveBeenCalled();
		expect(streamCalls, label).toBe(1);
		expect(
			events.some((event) => event.type.startsWith("tool_execution_")),
			label,
		).toBe(false);
		expect(finalAssistant, label).toMatchObject({ stopReason: "error", content: [] });
	}
});
