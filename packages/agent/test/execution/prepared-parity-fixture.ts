// S36 (senpi#5728): one agent turn, run on the loop's own scheduler or on the prepared pipeline, reduced to what a
// session observes: start order, each call's own events, the result messages and whether the loop asked again.
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type JsonObject,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Agent } from "../../src/agent.ts";
import { createPreparedToolHost } from "../../src/execution/prepared/pipeline-prepared.ts";
import type { AgentEvent, AgentTool, AgentToolCall } from "../../src/types.ts";

export type Pipeline = "legacy" | "prepared";

export interface Observation {
	readonly starts: readonly string[];
	readonly calls: Readonly<Record<string, string>>;
	readonly results: readonly string[];
	readonly turns: number;
}

export interface Scenario {
	readonly calls: readonly AgentToolCall[];
	readonly setup?: (agent: Agent) => void;
	readonly expected: Observation;
}

const model: Model<"openai-completions"> = {
	id: "parity",
	name: "parity",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
};

function reply(content: AssistantMessage["content"]) {
	const stopReason = content.some((item) => item.type === "toolCall") ? "toolUse" : "stop";
	const message: AssistantMessage = {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: 1,
		content,
		stopReason,
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
	stream.push({ type: "done", reason: stopReason, message });
	return stream;
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });

export const echo: AgentTool = {
	name: "echo",
	label: "echo",
	description: "echo the arguments after one update",
	parameters: Type.Object({}, { additionalProperties: true }),
	execute: async (_id, params, _signal, onUpdate) => {
		await onUpdate?.(text("working"));
		return text(JSON.stringify(params));
	},
};

export const tools: readonly AgentTool[] = [
	echo,
	{ ...echo, name: "serial", executionMode: "sequential" },
	{ ...echo, name: "strict", parameters: Type.Object({ path: Type.String() }) },
	{
		...echo,
		name: "boom",
		execute: async () => {
			throw new Error("boom failed");
		},
	},
	{ ...echo, name: "stopper", execute: async () => ({ ...text("stop here"), terminate: true }) },
];

export function call(
	id: string,
	name: string,
	args: JsonObject = {},
	extra: Partial<AgentToolCall> = {},
): AgentToolCall {
	return { type: "toolCall", id, name, arguments: args, ...extra };
}

function resultText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content.map((part: { type?: string; text?: string }) => (part.type === "text" ? part.text : "")).join("");
}

export async function observe(pipeline: Pipeline, scenario: Scenario): Promise<Observation> {
	let turns = 0;
	const agent = new Agent({
		initialState: { model, tools: [...tools] },
		streamFn: () => reply(turns++ === 0 ? [...scenario.calls] : [{ type: "text", text: "done" }]),
	});
	scenario.setup?.(agent);
	if (pipeline === "prepared") agent.toolHost = createPreparedToolHost(agent);
	const starts: string[] = [];
	const calls: Record<string, string[]> = {};
	const push = (id: string, step: string) => {
		calls[id] = [...(calls[id] ?? []), step];
	};
	agent.subscribe((event: AgentEvent) => {
		if (event.type === "tool_execution_start") {
			starts.push(`${event.toolCallId} ${event.toolName}`);
			push(event.toolCallId, "start");
		} else if (event.type === "tool_execution_update") push(event.toolCallId, "update");
		else if (event.type === "tool_execution_end") push(event.toolCallId, event.isError ? "end!" : "end");
		else if (event.type === "message_end" && event.message.role === "toolResult")
			push(event.message.toolCallId, "msg");
	});
	await agent.prompt("go").catch(() => undefined);
	const results = agent.state.messages.flatMap((message) =>
		message.role === "toolResult"
			? [
					`${message.toolCallId} ${message.toolName} ${message.isError ? "error" : "ok"} ${resultText(message.content)}`,
				]
			: [],
	);
	const joined = Object.fromEntries(Object.entries(calls).map(([id, steps]) => [id, steps.join(" ")]));
	return { starts, calls: joined, results, turns: agent.state.messages.filter((m) => m.role === "assistant").length };
}
