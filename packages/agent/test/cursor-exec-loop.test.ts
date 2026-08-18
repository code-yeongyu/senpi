import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	kCursorExecResolved,
	type Message,
	type Model,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { agentLoop } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentTool } from "../src/types.ts";

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

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "cursor-agent",
		provider: "cursor",
		model: "mock-cursor",
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

function resolvedToolCall(id: string): AssistantMessage["content"][number] {
	const block = {
		type: "toolCall" as const,
		id,
		name: "bash",
		arguments: { command: "echo hi" },
	};
	(block as Record<PropertyKey, unknown>)[kCursorExecResolved] = true;
	return block;
}

function bufferedResult(toolCallId: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text: "exec-channel output" }],
		isError: false,
		timestamp: 0,
	};
}

describe("cursor exec-channel integration in the agent loop", () => {
	it("skips provider-resolved tool calls and appends buffered results after the assistant message", async () => {
		const execute = vi.fn();
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [bashTool(execute)] };
		const config: AgentLoopConfig = {
			model: model(),
			convertToLlm: (messages) => messages.filter((message): message is Message => "role" in message),
			// Presence of exec handlers is what makes the loop install its
			// buffering onToolResult on the stream options.
			cursorExecHandlers: {},
		};

		const events: AgentEvent[] = [];
		const stream = agentLoop(
			[{ role: "user", content: "run it", timestamp: 0 }],
			context,
			config,
			undefined,
			(_model, _context, options) => {
				const response = createAssistantMessageEventStream();
				const message = assistant([{ type: "text", text: "running" }, resolvedToolCall("cursor-call-1")]);
				// The provider executed the tool mid-stream and buffered its result.
				const onToolResult = (options as { onToolResult?: (result: ToolResultMessage) => void }).onToolResult;
				onToolResult?.(bufferedResult("cursor-call-1"));
				queueMicrotask(() => {
					response.push({ type: "done", reason: "stop", message });
					response.end();
				});
				return response;
			},
		);
		for await (const event of stream) {
			events.push(event);
		}
		const messages = await stream.result();

		// The loop must not re-execute the resolved call.
		expect(execute).not.toHaveBeenCalled();

		// Message order: user, assistant, buffered tool result.
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
		const toolResult = messages[2] as ToolResultMessage;
		expect(toolResult.toolCallId).toBe("cursor-call-1");
		expect(toolResult.content).toEqual([{ type: "text", text: "exec-channel output" }]);

		// The buffered result is emitted as ordinary message events and included
		// in turn_end's toolResults.
		const toolResultEnd = events.find((event) => event.type === "message_end" && event.message.role === "toolResult");
		expect(toolResultEnd).toBeDefined();
		const turnEnd = events.find((event) => event.type === "turn_end");
		expect(turnEnd?.type === "turn_end" && turnEnd.toolResults).toHaveLength(1);
	});

	it("still executes unresolved tool calls alongside resolved ones", async () => {
		const execute = vi.fn();
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [bashTool(execute)] };
		const config: AgentLoopConfig = {
			model: model(),
			convertToLlm: (messages) => messages.filter((message): message is Message => "role" in message),
			cursorExecHandlers: {},
		};

		let request = 0;
		const stream = agentLoop(
			[{ role: "user", content: "run both", timestamp: 0 }],
			context,
			config,
			undefined,
			(_model, _context, options) => {
				const response = createAssistantMessageEventStream();
				if (request++ === 0) {
					const message = assistant([
						resolvedToolCall("cursor-call-1"),
						{ type: "toolCall", id: "local-call-1", name: "bash", arguments: { command: "echo local" } },
					]);
					const onToolResult = (options as { onToolResult?: (result: ToolResultMessage) => void }).onToolResult;
					onToolResult?.(bufferedResult("cursor-call-1"));
					queueMicrotask(() => {
						response.push({ type: "done", reason: "toolUse", message });
						response.end();
					});
				} else {
					const message = assistant([{ type: "text", text: "done" }]);
					queueMicrotask(() => {
						response.push({ type: "done", reason: "stop", message });
						response.end();
					});
				}
				return response;
			},
		);
		for await (const _event of stream) {
			// consume
		}
		const messages = await stream.result();

		// Only the unresolved call executed locally.
		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute).toHaveBeenCalledWith({ command: "echo local" });

		const toolResults = messages.filter((message): message is ToolResultMessage => message.role === "toolResult");
		expect(toolResults.map((result) => result.toolCallId).sort()).toEqual(["cursor-call-1", "local-call-1"]);
	});

	it("keeps buffered results paired when the assistant turn terminates with an error", async () => {
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: model(),
			convertToLlm: (messages) => messages.filter((message): message is Message => "role" in message),
			cursorExecHandlers: {},
		};

		const stream = agentLoop(
			[{ role: "user", content: "run it", timestamp: 0 }],
			context,
			config,
			undefined,
			(_model, _context, options) => {
				const response = createAssistantMessageEventStream();
				const message = assistant([resolvedToolCall("cursor-call-1")]);
				message.stopReason = "error";
				message.errorMessage = "connection lost";
				const onToolResult = (options as { onToolResult?: (result: ToolResultMessage) => void }).onToolResult;
				onToolResult?.(bufferedResult("cursor-call-1"));
				queueMicrotask(() => {
					response.push({ type: "error", reason: "error", error: message });
					response.end();
				});
				return response;
			},
		);
		for await (const _event of stream) {
			// consume
		}
		const messages = await stream.result();

		// The buffered result still lands right after the failed assistant
		// message, keeping the resolved call paired for transcript rebuilds.
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "toolResult"]);
	});

	it("re-arms the idle timeout while the stream reports pending local work", async () => {
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: model(),
			convertToLlm: (messages) => messages.filter((message): message is Message => "role" in message),
			timeoutMs: 40,
		};

		const stream = agentLoop(
			[{ role: "user", content: "slow tool", timestamp: 0 }],
			context,
			config,
			undefined,
			() => {
				const response = createAssistantMessageEventStream();
				void (async () => {
					response.push({ type: "start", partial: assistant([]) });
					// Local work (a bridged tool run) spans several idle windows;
					// the reader must re-arm rather than abort.
					await response.trackLocalWork(new Promise((resolve) => setTimeout(resolve, 150)));
					const message = assistant([{ type: "text", text: "finished after local work" }]);
					response.push({ type: "done", reason: "stop", message });
					response.end();
				})();
				return response;
			},
		);
		for await (const _event of stream) {
			// consume
		}
		const messages = await stream.result();
		const assistantMessage = messages.find((message): message is AssistantMessage => message.role === "assistant");
		expect(assistantMessage?.stopReason).toBe("stop");
		expect(assistantMessage?.content).toEqual([{ type: "text", text: "finished after local work" }]);
	});

	it("aborts on genuine idleness even when local work support is present", async () => {
		const context: AgentContext = { systemPrompt: "", messages: [], tools: [] };
		const config: AgentLoopConfig = {
			model: model(),
			convertToLlm: (messages) => messages.filter((message): message is Message => "role" in message),
			timeoutMs: 40,
		};

		const stream = agentLoop([{ role: "user", content: "hang", timestamp: 0 }], context, config, undefined, () => {
			const response = createAssistantMessageEventStream();
			response.push({ type: "start", partial: assistant([]) });
			// No further events and no local work: genuinely idle.
			return response;
		});
		for await (const _event of stream) {
			// consume
		}
		const messages = await stream.result();
		const assistantMessage = messages.find((message): message is AssistantMessage => message.role === "assistant");
		expect(assistantMessage?.stopReason).toBe("error");
		expect(assistantMessage?.errorMessage).toContain("Idle timeout");
	});
});
