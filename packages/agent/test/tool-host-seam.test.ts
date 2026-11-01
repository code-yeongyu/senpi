// senpi#4360, S18a: the seam must be above preparation, not around tool.execute.
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent } from "../src/agent.ts";
import type { AgentEvent, AgentTool, ToolHost, ToolHostCall } from "../src/types.ts";

const model: Model<"openai-completions"> = {
	id: "seam-test",
	name: "seam-test",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};
const call = { type: "toolCall", id: "call-1", name: "read", arguments: { raw: "a" } } as const;
const scope = { id: "opaque-scope", root: "/workspace" };
function response(content: AssistantMessage["content"]) {
	const message: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: 1,
		content,
		stopReason: content.some((item) => item.type === "toolCall") ? "toolUse" : "stop",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	const stream = createAssistantMessageEventStream();
	stream.push({
		type: "done",
		reason: content.some((item) => item.type === "toolCall") ? "toolUse" : "stop",
		message,
	});
	return stream;
}

function fixture(toolHost?: ToolHost) {
	const trace: string[] = [];
	const tool: AgentTool = {
		name: "read",
		label: "read",
		description: "fixture",
		parameters: Type.Object({ path: Type.String() }),
		prepareArguments: () => {
			trace.push("prepare");
			return { path: "prepared" };
		},
		execute: async () => {
			trace.push("body");
			return { content: [{ type: "text", text: "local" }], details: {} };
		},
	};
	let turns = 0;
	const agent = new Agent({
		initialState: { model, tools: [tool] },
		streamFn: () => response(turns++ === 0 ? [call] : [{ type: "text", text: "done" }]),
		toolHost,
		executionScope: scope,
		beforeToolCall: async () => {
			trace.push("before");
			return undefined;
		},
		afterToolCall: async () => {
			trace.push("after");
			return undefined;
		},
	});
	return { agent, trace };
}

describe("unprepared ToolHost seam", () => {
	it("passes the raw call and opaque scope before any local resolution, preparation or hook", async () => {
		const received: ToolHostCall[] = [];
		const { agent, trace } = fixture({
			execute: async (request, options) => {
				received.push(request);
				const message: ToolResultMessage = {
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: "remote" }],
					isError: false,
					timestamp: 2,
				};
				await options.emit({ type: "message_start", message });
				await options.emit({ type: "message_end", message });
				return {
					messages: [message],
					terminate: false,
				};
			},
		});
		await agent.prompt("run");
		expect(received).toEqual([{ scope, calls: [call], mode: "parallel" }]);
		expect(trace).toEqual([]);
		expect(agent.state.messages.find((message) => message.role === "toolResult")?.content).toEqual([
			{ type: "text", text: "remote" },
		]);
	});

	for (const mode of ["parallel", "sequential"] as const) {
		it(`keeps legacy ${mode} hook ordering and records the pipeline separately from public events`, async () => {
			const { agent, trace } = fixture();
			agent.toolExecution = mode;
			const witnesses: unknown[] = [];
			const events: AgentEvent[] = [];
			agent.onExecutionPipeline = (witness) => {
				witnesses.push(witness);
			};
			agent.subscribe((event) => {
				events.push(event);
			});
			await agent.prompt("run");
			expect(trace).toEqual(["prepare", "before", "body", "after"]);
			expect(witnesses).toEqual([{ pipeline: "legacy", toolCallId: call.id }]);
			expect(events.filter((event) => event.type === "tool_execution_end")).toHaveLength(1);
			expect(events.some((event) => "pipeline" in event)).toBe(false);
		});
	}
});
