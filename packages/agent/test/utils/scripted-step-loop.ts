import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { runAgentLoop } from "../../src/index.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	StepCommit,
} from "../../src/types.ts";

class ScriptedStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("unexpected event");
			},
		);
	}
}

const model: Model<"openai-responses"> = {
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

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
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
		timestamp: 1,
	};
}

export const user: UserMessage = { role: "user", content: "go", timestamp: 1 };

export const providerResult: ToolResultMessage = {
	role: "toolResult",
	toolCallId: "srv-1",
	toolName: "server_exec",
	content: [{ type: "text", text: "ran on the provider" }],
	isError: false,
	timestamp: 1,
};

export type Step = { readonly message: AssistantMessage; readonly emitProviderResult?: boolean };

export function scripted(steps: readonly Step[]) {
	let index = 0;
	return (
		_model: Model<Api>,
		_context: unknown,
		options?: SimpleStreamOptions & { onToolResult?: (r: ToolResultMessage) => void },
	) => {
		const step = steps[index++];
		if (!step) throw new Error("no scripted step left");
		const stream = new ScriptedStream();
		queueMicrotask(() => {
			if (step.emitProviderResult) options?.onToolResult?.(providerResult);
			const reason = step.message.stopReason;
			if (reason === "error" || reason === "aborted") {
				stream.push({ type: "error", reason, error: step.message });
			} else if (reason !== "pending") {
				stream.push({ type: "done", reason, message: step.message });
			}
		});
		return stream;
	};
}

const toolSchema = Type.Object({});

export function contextWith(executed: string[]): AgentContext {
	const tool: AgentTool<typeof toolSchema> = {
		name: "local",
		label: "local",
		description: "local",
		parameters: toolSchema,
		execute: async (toolCallId) => {
			executed.push(toolCallId);
			return { content: [{ type: "text", text: "ok" }], details: undefined };
		},
	};
	return { messages: [], tools: [tool] };
}

export function baseConfig(extra: Partial<AgentLoopConfig> = {}): AgentLoopConfig {
	return {
		model,
		convertToLlm: (messages: AgentMessage[]) =>
			messages.filter((m): m is Message => m.role === "user" || m.role === "assistant" || m.role === "toolResult"),
		cursorExecHandlers: {},
		...extra,
	};
}

export const toolStep: Step = {
	message: assistant([{ type: "toolCall", id: "call-1", name: "local", arguments: {} }], "toolUse"),
	emitProviderResult: true,
};
export const stopStep: Step = { message: assistant([{ type: "text", text: "done" }], "stop") };
export const errorStep: Step = { message: { ...assistant([], "error"), errorMessage: "provider exploded" } };

function label(event: AgentEvent): string {
	if (event.type === "message_start" || event.type === "message_end") return `${event.type}:${event.message.role}`;
	if (event.type === "tool_execution_start" || event.type === "tool_execution_end")
		return `${event.type}:${event.toolCallId}`;
	return event.type;
}

export async function run(steps: readonly Step[], extra: Partial<AgentLoopConfig> = {}) {
	const trace: string[] = [];
	const executed: string[] = [];
	let failure: unknown;
	const messages = await runAgentLoop(
		[user],
		contextWith(executed),
		baseConfig({
			...extra,
			...(extra.commitStep
				? {
						commitStep: async (step: StepCommit) => {
							trace.push(`commit:${step.message.stopReason}:${step.providerToolResults.length}`);
							await extra.commitStep?.(step);
						},
					}
				: {}),
		}),
		(event) => {
			trace.push(label(event));
		},
		undefined,
		scripted(steps),
	).catch((error: unknown) => {
		failure = error;
		return undefined;
	});
	return { trace, executed, messages, failure };
}
