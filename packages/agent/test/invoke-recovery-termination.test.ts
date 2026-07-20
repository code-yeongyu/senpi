import {
	type AssistantMessage,
	AssistantMessageEventStream,
	type Message,
	type Model,
	wrapStreamWithInvokeRecovery,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

const schema = Type.Object({ command: Type.String() });
const recoveryTool = { name: "Bash", description: "Run a command", parameters: schema };
const completeInvoke = '<invoke name="Bash"><parameter name="command">echo recovered</parameter></invoke>';
const danglingInvoke = '<invoke name="Bash"><parameter name="command">echo partial';

type Scenario = "abort-before" | "abort-start" | "abort-complete" | "dangling-error" | "complete-error";

function assistant(content: AssistantMessage["content"] = [], stopReason: AssistantMessage["stopReason"] = "stop") {
	return {
		role: "assistant" as const,
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "claude-test",
		content,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
	};
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

function recoveredStream(scenario: Scenario) {
	const inner = new AssistantMessageEventStream();
	const wrapped = wrapStreamWithInvokeRecovery(inner, [recoveryTool]);
	if (scenario === "abort-before") {
		const aborted = assistant([], "aborted");
		aborted.errorMessage = "Request was aborted";
		inner.push({ type: "error", reason: "aborted", error: aborted });
		return wrapped;
	}
	const xml = scenario === "abort-complete" || scenario === "complete-error" ? completeInvoke : danglingInvoke;
	const partial = assistant([]);
	inner.push({ type: "start", partial });
	partial.content.push({ type: "text", text: "" });
	inner.push({ type: "text_start", contentIndex: 0, partial });
	partial.content[0] = { type: "text", text: xml };
	inner.push({ type: "text_delta", contentIndex: 0, delta: xml, partial });
	if (scenario === "abort-complete" || scenario === "complete-error") {
		inner.push({ type: "text_end", contentIndex: 0, content: xml, partial });
	}
	const reason = scenario.startsWith("abort") ? "aborted" : "error";
	const failed = assistant([{ type: "text", text: xml }], reason);
	failed.errorMessage = reason === "aborted" ? "Request was aborted" : "transport failed";
	inner.push({ type: "error", reason, error: failed });
	return wrapped;
}

function finalStream() {
	const stream = new AssistantMessageEventStream();
	stream.push({ type: "done", reason: "stop", message: assistant([{ type: "text", text: "done" }]) });
	return stream;
}

function isLlmMessage(message: AgentMessage): message is Message {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

async function collectBounded(stream: ReturnType<typeof agentLoop>) {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			(async () => {
				const events: AgentEvent[] = [];
				for await (const event of stream) events.push(event);
				return { events, messages: await stream.result() };
			})(),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error("recovery termination agent probe did not finish")), 500);
			}),
		]);
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

it("preserves recovery termination rules through the actual agent loop", async () => {
	for (const scenario of [
		"abort-before",
		"abort-start",
		"abort-complete",
		"dangling-error",
		"complete-error",
	] satisfies Scenario[]) {
		const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "executed" }], details: {} }));
		const tool: AgentTool<typeof schema, Record<string, never>> = {
			name: "Bash",
			label: "Bash",
			description: "Run a command",
			parameters: schema,
			execute,
		};
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = { model: model(), convertToLlm: (messages) => messages.filter(isLlmMessage) };
		let streamCalls = 0;
		const stream = agentLoop([{ role: "user", content: scenario, timestamp: 1 }], context, config, undefined, () => {
			streamCalls += 1;
			return streamCalls === 1 ? recoveredStream(scenario) : finalStream();
		});
		const { events, messages } = await collectBounded(stream);
		const assistants = messages.filter((message) => message.role === "assistant");

		if (scenario.startsWith("abort")) {
			expect(streamCalls, scenario).toBe(1);
			expect(execute, scenario).not.toHaveBeenCalled();
			expect(
				events.some((event) => event.type.startsWith("tool_execution_")),
				scenario,
			).toBe(false);
			expect(assistants.at(-1), scenario).toMatchObject({ stopReason: "aborted" });
		} else {
			expect(streamCalls, scenario).toBe(2);
			expect(execute, scenario).toHaveBeenCalledTimes(scenario === "complete-error" ? 1 : 0);
			expect(assistants[0], scenario).toMatchObject({ stopReason: "toolUse" });
			if (scenario === "dangling-error") {
				expect(assistants[0]?.content).toContainEqual(
					expect.objectContaining({ type: "toolCall", incomplete: true }),
				);
			}
		}
	}
});
