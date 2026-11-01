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
import { Agent } from "../src/agent.ts";
import { agentLoop, localToolHost, runToolCall } from "../src/agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool, ToolHost } from "../src/types.ts";

/**
 * senpi#4360: tool execution sits behind one ToolHost boundary. The loop keeps name resolution, argument
 * preparation, schema validation and the before/after hooks; the host only executes the prepared call. With no host
 * configured, localToolHost runs tool.execute in-process (the fused mode), so nothing changes for existing callers.
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

type Seen = { toolCallId: string; toolName: string; args: unknown };
const recordingHost = (seen: Seen[], reply?: (call: Seen) => Record<string, unknown>): ToolHost => ({
	async execute(call, signal, onUpdate, local) {
		seen.push({ toolCallId: call.toolCallId, toolName: call.toolName, args: call.args });
		if (reply) {
			onUpdate?.({ content: [{ type: "text", text: "partial" }], details: {} } as never);
			return reply(call) as never;
		}
		return localToolHost.execute(call, signal, onUpdate, local);
	},
});
function echoTool(name: string, sequential = false): AgentTool<ReturnType<typeof Type.Object>, unknown> {
	return {
		name,
		label: name,
		description: name,
		parameters: Type.Object({ n: Type.Number() }),
		prepareArguments: (args) => ({ n: Number((args as { n: unknown }).n) }),
		...(sequential ? { executionMode: "sequential" as const } : {}),
		async execute(_id, params) {
			return { content: [{ type: "text", text: `local ${params.n}` }], details: { local: true } };
		},
	};
}
async function runCalls(
	config: Partial<AgentLoopConfig>,
	tools: ReturnType<typeof echoTool>[],
	calls: { id: string; name: string; arguments: Record<string, unknown> }[],
	signal?: AbortSignal,
) {
	const context: AgentContext = { systemPrompt: "", messages: [], tools };
	const full: AgentLoopConfig = { model: createModel(), convertToLlm: (m) => m.filter(isLlmMessage), ...config };
	let llmCalls = 0;
	const events: AgentEvent[] = [];
	const stream = agentLoop([createUserMessage("go")], context, full, signal, () => {
		llmCalls++;
		const s = new MockAssistantStream();
		queueMicrotask(() =>
			s.push({
				type: "done",
				reason: llmCalls === 1 ? "toolUse" : "stop",
				message:
					llmCalls === 1
						? createAssistantMessage(
								calls.map((c) => ({ type: "toolCall" as const, ...c })) as AssistantMessage["content"],
								"toolUse",
							)
						: createAssistantMessage([{ type: "text", text: "done" }], "stop"),
			}),
		);
		return s;
	});
	for await (const e of stream) events.push(e);
	return events;
}
const results = (events: AgentEvent[]) =>
	events.flatMap((e) =>
		e.type === "message_start" && e.message.role === "toolResult"
			? [
					{
						id: e.message.toolCallId,
						text: (e.message.content[0] as { text?: string }).text,
						isError: e.message.isError,
					},
				]
			: [],
	);

describe("ToolHost seam (senpi#4360)", () => {
	for (const toolExecution of ["sequential", "parallel"] as const) {
		it(`${toolExecution}: the host receives the prepared, validated call and its result becomes the tool result`, async () => {
			const seen: Seen[] = [];
			const events = await runCalls(
				{
					toolExecution,
					toolHost: recordingHost(seen, (c) => ({
						content: [{ type: "text", text: `host ${c.toolCallId}` }],
						details: {},
					})),
				},
				[echoTool("echo")],
				[
					{ id: "a", name: "echo", arguments: { n: "1" } },
					{ id: "b", name: "echo", arguments: { n: "2" } },
				],
			);
			expect(seen).toEqual([
				{ toolCallId: "a", toolName: "echo", args: { n: 1 } },
				{ toolCallId: "b", toolName: "echo", args: { n: 2 } },
			]);
			expect(results(events)).toEqual([
				{ id: "a", text: "host a", isError: false },
				{ id: "b", text: "host b", isError: false },
			]);
			expect(events.some((e) => e.type === "tool_execution_update")).toBe(true);
		});
	}
	it("afterToolCall sees the host's result", async () => {
		const seen: Seen[] = [];
		const after: string[] = [];
		await runCalls(
			{
				toolHost: recordingHost(seen, () => ({ content: [{ type: "text", text: "from host" }], details: {} })),
				afterToolCall: async ({ result }) => {
					after.push((result.content[0] as { text: string }).text);
					return undefined;
				},
			},
			[echoTool("echo")],
			[{ id: "a", name: "echo", arguments: { n: 1 } }],
		);
		expect(after).toEqual(["from host"]);
	});
	it("an unknown tool or a schema-invalid call never reaches the host (the loop keeps validation)", async () => {
		const seen: Seen[] = [];
		const events = await runCalls(
			{ toolHost: recordingHost(seen) },
			[echoTool("echo")],
			[
				{ id: "a", name: "nope", arguments: {} },
				{ id: "b", name: "echo", arguments: { n: "x" } },
			],
		);
		expect(seen).toEqual([]);
		expect(results(events).map((r) => r.isError)).toEqual([true, true]);
	});
	it("a host that throws becomes an isError result, like a throwing tool", async () => {
		const host: ToolHost = {
			execute: async () => {
				throw new Error("host down");
			},
		};
		const events = await runCalls(
			{ toolHost: host },
			[echoTool("echo")],
			[{ id: "a", name: "echo", arguments: { n: 1 } }],
		);
		expect(results(events)).toEqual([{ id: "a", text: "host down", isError: true }]);
	});
	it("runToolCall goes through the host too", async () => {
		const seen: Seen[] = [];
		const outcome = await runToolCall(
			{ type: "toolCall", id: "r", name: "echo", arguments: { n: 3 } },
			{
				tools: [echoTool("echo")],
				assistantMessage: createAssistantMessage([]),
				context: { messages: [] },
				toolHost: recordingHost(seen),
			},
		);
		expect(seen).toEqual([{ toolCallId: "r", toolName: "echo", args: { n: 3 } }]);
		expect((outcome.result.content[0] as { text: string }).text).toBe("local 3");
	});
	it("with no host configured, the local in-process host runs the tool (fused mode, unchanged)", async () => {
		const events = await runCalls({}, [echoTool("echo")], [{ id: "a", name: "echo", arguments: { n: 5 } }]);
		expect(results(events)).toEqual([{ id: "a", text: "local 5", isError: false }]);
	});
	it("the call record is serializable (no live tool object) and its args are the loop's prepared args", async () => {
		const received: unknown[] = [];
		const prepared: unknown[] = [];
		await runCalls(
			{
				toolHost: {
					async execute(call, signal, onUpdate, local) {
						received.push(call);
						expect(Object.keys(call).sort()).toEqual(["args", "toolCallId", "toolName"]);
						expect(JSON.parse(JSON.stringify(call))).toEqual(call);
						return localToolHost.execute(call, signal, onUpdate, local);
					},
				},
				beforeToolCall: async ({ args }) => {
					prepared.push(args);
					return undefined;
				},
			},
			[echoTool("echo")],
			[{ id: "a", name: "echo", arguments: { n: "7" } }],
		);
		expect((received[0] as { args: unknown }).args).toBe(prepared[0]);
	});
	it("localToolHost refuses a call without the in-process tool (a remote call record alone cannot run locally)", async () => {
		await expect(
			Promise.resolve().then(() =>
				localToolHost.execute({ toolCallId: "x", toolName: "echo", args: {} }, undefined, () => {}),
			),
		).rejects.toThrow("localToolHost needs the in-process tool");
	});
	it("abort settles the call even when the host ignores the signal", async () => {
		const controller = new AbortController();
		const host: ToolHost = {
			execute: () => {
				queueMicrotask(() => controller.abort());
				return new Promise(() => {});
			},
		};
		const events = await runCalls(
			{ toolHost: host },
			[echoTool("echo")],
			[{ id: "a", name: "echo", arguments: { n: 1 } }],
			controller.signal,
		);
		expect(results(events)).toEqual([{ id: "a", text: "Tool execution aborted", isError: true }]);
	});
	it("Agent passes its toolHost option to the loop", async () => {
		const seen: Seen[] = [];
		let llmCalls = 0;
		const agent = new Agent({
			toolHost: recordingHost(seen, (c) => ({
				content: [{ type: "text", text: `host ${c.toolCallId}` }],
				details: {},
			})),
			initialState: { model: createModel(), tools: [echoTool("echo")] },
			convertToLlm: (m) => m.filter(isLlmMessage),
			streamFn: () => {
				llmCalls++;
				const s = new MockAssistantStream();
				queueMicrotask(() =>
					s.push({
						type: "done",
						reason: llmCalls === 1 ? "toolUse" : "stop",
						message:
							llmCalls === 1
								? createAssistantMessage(
										[{ type: "toolCall", id: "g", name: "echo", arguments: { n: 9 } }],
										"toolUse",
									)
								: createAssistantMessage([{ type: "text", text: "done" }], "stop"),
					}),
				);
				return s;
			},
		});
		await agent.prompt("go");
		expect(seen).toEqual([{ toolCallId: "g", toolName: "echo", args: { n: 9 } }]);
	});
});
