import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Message,
	Tool,
	ToolCall,
} from "@earendil-works/pi-ai/compat";
import {
	AuthGatewayAdapterError,
	type AuthGatewayAdapterRequest,
	type AuthGatewayAdapterResponse,
	type AuthGatewayAdapterRuntime,
	exactKeys,
	invalidRequest,
	optionalBoolean,
	optionalNumber,
	parseToolSchema,
	readRecord,
	requiredArray,
	requiredString,
	safeError,
	selectorFromHeaders,
	unknownModel,
} from "./auth-gateway-protocol-adapter.ts";

export type OpenAIChatGatewayAdapter = {
	handle(request: AuthGatewayAdapterRequest): Promise<AuthGatewayAdapterResponse>;
};

export function createOpenAIChatGatewayAdapter(options: {
	readonly provider: string;
	readonly runtime: AuthGatewayAdapterRuntime;
}): OpenAIChatGatewayAdapter {
	return {
		async handle(request) {
			try {
				const parsed = parseOpenAIChatRequest(request.body);
				const result = await options.runtime.stream({
					context: parsed.context,
					modelId: parsed.model,
					provider: options.provider,
					selector: selectorFromHeaders(request.headers),
					signal: request.signal,
					streamOptions: parsed.streamOptions,
				});
				if (result.kind === "model_not_found") return unknownModel();
				if (result.kind !== "stream") return safeError(result.statusCode);
				if (parsed.stream)
					return { frames: openAiFrames(result.stream, result.model.id), kind: "sse", statusCode: 200 };
				const message = await result.stream.result();
				if (message.stopReason === "error" || message.stopReason === "aborted") return safeError(502);
				return {
					body: openAiCompletion(message, result.model.id),
					kind: "json",
					statusCode: 200,
				};
			} catch (error) {
				if (error instanceof AuthGatewayAdapterError) return invalidRequest(error);
				return safeError(503);
			}
		},
	};
}

function parseOpenAIChatRequest(value: unknown): {
	readonly context: Context;
	readonly model: string;
	readonly stream: boolean;
	readonly streamOptions: { readonly maxTokens?: number; readonly temperature?: number } | undefined;
} {
	const record = readRecord(value);
	exactKeys(record, ["max_completion_tokens", "max_tokens", "messages", "model", "stream", "temperature", "tools"]);
	const maxCompletionTokens = optionalNumber(record, "max_completion_tokens");
	const maxTokens = optionalNumber(record, "max_tokens");
	const temperature = optionalNumber(record, "temperature");
	const rawMessages = requiredArray(record, "messages");
	const toolNamesByCallId = openAiToolNamesByCallId(rawMessages);
	const messages = rawMessages.map((entry) => parseMessage(entry, toolNamesByCallId));
	const tools = record.tools === undefined ? undefined : parseTools(record.tools);
	const system = messages
		.filter((message) => message.role === "system")
		.map((message) => message.content)
		.join("\n");
	const resolvedMaxTokens = maxCompletionTokens ?? maxTokens;
	const streamOptions =
		resolvedMaxTokens === undefined && temperature === undefined
			? undefined
			: {
					...(resolvedMaxTokens === undefined ? {} : { maxTokens: resolvedMaxTokens }),
					...(temperature === undefined ? {} : { temperature }),
				};
	return {
		context: {
			messages: messages.filter((message) => message.role !== "system"),
			systemPrompt: system || undefined,
			tools,
		},
		model: requiredString(record, "model"),
		stream: optionalBoolean(record, "stream") ?? false,
		streamOptions,
	};
}

function openAiToolNamesByCallId(messages: readonly unknown[]): Map<string, string> {
	const names = new Map<string, string>();
	for (const entry of messages) {
		if (!isRecord(entry) || entry.role !== "assistant" || !Array.isArray(entry.tool_calls)) continue;
		for (const call of entry.tool_calls) {
			if (!isRecord(call) || typeof call.id !== "string" || !isRecord(call.function)) continue;
			const name = call.function.name;
			if (typeof name === "string" && name.length > 0) names.set(call.id, name);
		}
	}
	return names;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMessage(
	value: unknown,
	toolNamesByCallId: ReadonlyMap<string, string>,
): Message | { readonly content: string; readonly role: "system" } {
	const record = readRecord(value);
	const role = requiredString(record, "role");
	if (role === "system" || role === "developer") {
		exactKeys(record, ["content", "role"]);
		return { content: textContent(record.content, "content"), role: "system" };
	}
	if (role === "user") {
		exactKeys(record, ["content", "role"]);
		return { content: textContent(record.content, "content"), role: "user", timestamp: 0 };
	}
	if (role === "tool") {
		exactKeys(record, ["content", "role", "tool_call_id"]);
		const toolCallId = requiredString(record, "tool_call_id");
		return {
			content: [{ text: textContent(record.content, "content"), type: "text" }],
			isError: false,
			role: "toolResult",
			timestamp: 0,
			toolCallId,
			toolName: toolNamesByCallId.get(toolCallId) ?? "tool",
		};
	}
	if (role === "assistant") {
		exactKeys(record, ["content", "role", "tool_calls"]);
		const content = record.content === null ? "" : textContent(record.content, "content");
		const toolCalls = record.tool_calls === undefined ? [] : parseToolCalls(record.tool_calls);
		return {
			api: "openai-completions",
			content: [{ text: content, type: "text" }, ...toolCalls],
			model: "gateway-history",
			provider: "gateway-history",
			role: "assistant",
			stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
			timestamp: 0,
			usage: zeroUsage(),
		};
	}
	throw new AuthGatewayAdapterError("messages.role");
}

function textContent(value: unknown, field: string): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) throw new AuthGatewayAdapterError(field);
	return value
		.map((part) => {
			const record = readRecord(part);
			exactKeys(record, ["text", "type"]);
			if (record.type !== "text") throw new AuthGatewayAdapterError(field);
			return requiredString(record, "text");
		})
		.join("");
}

function parseTools(value: unknown): Tool[] {
	if (!Array.isArray(value)) throw new AuthGatewayAdapterError("tools");
	return value.map((entry) => {
		const record = readRecord(entry);
		exactKeys(record, ["function", "type"]);
		if (record.type !== "function") throw new AuthGatewayAdapterError("tools.type");
		const fn = readRecord(record.function);
		exactKeys(fn, ["description", "name", "parameters"]);
		return {
			description: requiredString(fn, "description"),
			name: requiredString(fn, "name"),
			parameters: parseToolSchema(fn.parameters),
		};
	});
}

function parseToolCalls(value: unknown): ToolCall[] {
	if (!Array.isArray(value)) throw new AuthGatewayAdapterError("tool_calls");
	return value.map((entry) => {
		const record = readRecord(entry);
		exactKeys(record, ["function", "id", "type"]);
		if (record.type !== "function") throw new AuthGatewayAdapterError("tool_calls.type");
		const fn = readRecord(record.function);
		exactKeys(fn, ["arguments", "name"]);
		const argumentsText = requiredString(fn, "arguments");
		let arguments_: unknown;
		try {
			arguments_ = JSON.parse(argumentsText);
		} catch {
			throw new AuthGatewayAdapterError("tool_calls.function.arguments");
		}
		return {
			arguments: readRecord(arguments_),
			id: requiredString(record, "id"),
			name: requiredString(fn, "name"),
			type: "toolCall",
		};
	});
}

function openAiCompletion(message: AssistantMessage, model: string): unknown {
	return {
		choices: [{ finish_reason: finishReason(message), index: 0, message: openAiMessage(message) }],
		created: Math.floor(message.timestamp / 1000),
		id: message.responseId ?? "gateway",
		model,
		object: "chat.completion",
	};
}

function openAiMessage(message: AssistantMessage): unknown {
	const text = message.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
	const thinking = message.content
		.filter((block) => block.type === "thinking")
		.map((block) => block.thinking)
		.join("");
	const toolCalls = message.content
		.filter((block): block is ToolCall => block.type === "toolCall")
		.map((block) => ({
			function: { arguments: JSON.stringify(block.arguments), name: block.name },
			id: block.id,
			type: "function",
		}));
	return {
		content: text || null,
		...(thinking ? { reasoning_content: thinking } : {}),
		role: "assistant",
		...(toolCalls.length ? { tool_calls: toolCalls } : {}),
	};
}

async function* openAiFrames(stream: AsyncIterable<AssistantMessageEvent>, model: string) {
	yield {
		data: {
			choices: [{ delta: { role: "assistant" }, finish_reason: null, index: 0 }],
			model,
			object: "chat.completion.chunk",
		},
		event: "message",
	};
	for await (const event of stream) {
		if (event.type === "text_delta")
			yield {
				data: {
					choices: [{ delta: { content: event.delta }, finish_reason: null, index: 0 }],
					model,
					object: "chat.completion.chunk",
				},
				event: "message",
			};
		if (event.type === "thinking_delta")
			yield {
				data: {
					choices: [{ delta: { reasoning_content: event.delta }, finish_reason: null, index: 0 }],
					model,
					object: "chat.completion.chunk",
				},
				event: "message",
			};
		if (event.type === "toolcall_end")
			yield {
				data: {
					choices: [
						{
							delta: {
								tool_calls: [
									{
										function: {
											arguments: JSON.stringify(event.toolCall.arguments),
											name: event.toolCall.name,
										},
										id: event.toolCall.id,
										index: event.contentIndex,
										type: "function",
									},
								],
							},
							finish_reason: null,
							index: 0,
						},
					],
					model,
					object: "chat.completion.chunk",
				},
				event: "message",
			};
		if (event.type === "done")
			yield {
				data: {
					choices: [{ delta: {}, finish_reason: finishReason(event.message), index: 0 }],
					model,
					object: "chat.completion.chunk",
				},
				event: "message",
			};
		if (event.type === "error")
			yield { data: { error: { message: "Gateway provider unavailable", type: "api_error" } }, event: "error" };
	}
	yield { data: "[DONE]", event: "message" };
}

function finishReason(message: AssistantMessage): "length" | "stop" | "tool_calls" {
	return message.stopReason === "length" ? "length" : message.stopReason === "toolUse" ? "tool_calls" : "stop";
}
function zeroUsage() {
	return {
		cacheRead: 0,
		cacheWrite: 0,
		cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
		input: 0,
		output: 0,
		totalTokens: 0,
	};
}
