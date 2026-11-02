import {
	type AssistantMessage,
	type CursorExecResolvedCarrier,
	createAssistantMessageEventStream,
	kCursorExecResolved,
	type Message,
	type Model,
	type ToolCall,
	wrapStreamWithModelRecovery,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentLoopConfig, AgentTool } from "../src/types.ts";

const Parameters = Type.Object({ command: Type.String() });

function model(): Model<"cursor-agent"> {
	return {
		id: "kimi-k3",
		name: "kimi-k3",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "cursor-agent",
		provider: "cursor",
		model: "kimi-k3",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function resolvedCall(): ToolCall {
	const block: ToolCall & CursorExecResolvedCarrier = {
		type: "toolCall",
		id: "cursor-call-1",
		name: "bash",
		arguments: { command: "echo hi" },
	};
	block[kCursorExecResolved] = true;
	return block;
}

describe("cursor exec marker after model recovery", () => {
	it("keeps total execution at one", async () => {
		let executions = 1;
		const tool: AgentTool<typeof Parameters> = {
			name: "bash",
			label: "bash",
			description: "Run a command",
			parameters: Parameters,
			execute: async () => {
				executions++;
				return { content: [{ type: "text", text: "ran" }], details: {} };
			},
		};
		const recoveryModel = model();
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [tool] };
		const config: AgentLoopConfig = {
			model: recoveryModel,
			convertToLlm: (messages) => messages.filter((message): message is Message => "role" in message),
		};
		let requests = 0;

		const stream = agentLoop([{ role: "user", content: "run it", timestamp: 0 }], context, config, undefined, () => {
			const response = createAssistantMessageEventStream();
			const message = requests++ === 0 ? assistant([resolvedCall()]) : assistant([{ type: "text", text: "done" }]);
			queueMicrotask(() => {
				response.push({ type: "start", partial: assistant([]) });
				const toolCall = message.content[0];
				if (toolCall?.type === "toolCall") {
					response.push({ type: "toolcall_start", contentIndex: 0, partial: message });
					response.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: message });
				}
				response.push({ type: "done", reason: "stop", message });
				response.end();
			});
			return wrapStreamWithModelRecovery(response, recoveryModel, context.tools ?? []);
		});
		for await (const _event of stream) {
			// consume
		}
		await stream.result();

		expect(executions).toBe(1);
	});
});
