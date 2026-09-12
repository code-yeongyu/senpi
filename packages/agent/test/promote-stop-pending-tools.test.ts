import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import { promoteStopWithPendingToolCalls, shouldTerminateAssistantTurn } from "../src/assistant-terminal-state.ts";
import type { AgentContext, AgentLoopConfig, AgentTool } from "../src/types.ts";

function msg(stopReason: AssistantMessage["stopReason"], content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		stopReason,
		content,
		api: "cursor-agent",
		provider: "cursor",
		model: "claude-fable-5-medium",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 0,
	} as AssistantMessage;
}

describe("promoteStopWithPendingToolCalls", () => {
	it("promotes stop with toolCalls to toolUse", () => {
		const next = promoteStopWithPendingToolCalls(
			msg("stop", [
				{ type: "text", text: "ok" },
				{ type: "toolCall", id: "1", name: "eval", arguments: {} },
			] as AssistantMessage["content"]),
		);
		expect(next.stopReason).toBe("toolUse");
		expect(shouldTerminateAssistantTurn(next)).toBe(false);
	});

	it("leaves text-only stop alone", () => {
		const next = promoteStopWithPendingToolCalls(
			msg("stop", [{ type: "text", text: "done" }] as AssistantMessage["content"]),
		);
		expect(next.stopReason).toBe("stop");
	});
});

function model(): Model<"cursor-agent"> {
	return {
		id: "mock-cursor",
		name: "mock-cursor",
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

const ToolParameters = Type.Object({ command: Type.String() });

function bashTool(execute: (params: unknown) => void): AgentTool<typeof ToolParameters> {
	return {
		name: "bash",
		label: "bash",
		description: "Run a command",
		parameters: ToolParameters,
		execute: async (_id, params) => {
			execute(params);
			return { content: [{ type: "text", text: "ran" }], details: {} };
		},
	};
}

describe("agent loop continues stop with pending toolCalls", () => {
	it("executes unresolved toolCalls when the provider ends as stop", async () => {
		const execute = vi.fn();
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [bashTool(execute)] };
		const config: AgentLoopConfig = {
			model: model(),
			convertToLlm: (messages) => messages.filter((message): message is Message => "role" in message),
		};

		let request = 0;
		const stream = agentLoop([{ role: "user", content: "run it", timestamp: 0 }], context, config, undefined, () => {
			const response = createAssistantMessageEventStream();
			if (request++ === 0) {
				const message = msg("stop", [
					{ type: "toolCall", id: "local-call-1", name: "bash", arguments: { command: "echo local" } },
				] as AssistantMessage["content"]);
				queueMicrotask(() => {
					response.push({ type: "done", reason: "stop", message });
					response.end();
				});
			} else {
				const message = msg("stop", [{ type: "text", text: "done" }]);
				queueMicrotask(() => {
					response.push({ type: "done", reason: "stop", message });
					response.end();
				});
			}
			return response;
		});
		for await (const _event of stream) {
			// consume
		}
		const messages = await stream.result();

		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute).toHaveBeenCalledWith({ command: "echo local" });
		expect(request).toBe(2);
		expect(messages.filter((message): message is ToolResultMessage => message.role === "toolResult")).toHaveLength(1);
	});
});
