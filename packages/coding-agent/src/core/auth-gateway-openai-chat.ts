import type {
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Message,
	Tool,
	ToolCall,
} from "@earendil-works/pi-ai/compat";
import { type TSchema, Type } from "typebox";
import {
	AuthGatewayAdapterError,
	type AuthGatewayAdapterRequest,
	type AuthGatewayAdapterResponse,
	type AuthGatewayAdapterRuntime,
	exactKeys,
	invalidRequest,
	optionalBoolean,
	optionalNumber,
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
				});
				if (result.kind === "model_not_found") return unknownModel();
				if (result.kind !== "stream") return safeError(result.statusCode);
				if (parsed.stream)
					return { frames: openAiFrames(result.stream, result.model.id), kind: "sse", statusCode: 200 };
				return {
					body: openAiCompletion(await result.stream.result(), result.model.id),
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
} {
	const record = readRecord(value);
	exactKeys(record, ["max_completion_tokens", "max_tokens", "messages", "model", "stream", "temperature", "tools"]);
	optionalNumber(record, "max_completion_tokens");
	optionalNumber(record, "max_tokens");
	optionalNumber(record, "temperature");
	const messages = requiredArray(record, "messages").map(parseMessage);
	const tools = record.tools === undefined ? undefined : parseTools(record.tools);
	const system = messages
		.filter((message) => message.role === "system")
		.map((message) => message.content)
		.join("\n");
	return {
		context: {
			messages: messages.filter((message) => message.role !== "system"),
			systemPrompt: system || undefined,
			tools,
		},
		model: requiredString(record, "model"),
		stream: optionalBoolean(record, "stream") ?? false,
	};
}

function parseMessage(value: unknown): Message | { readonly content: string; readonly role: "system" } {
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
		return {
			content: [{ text: textContent(record.content, "content"), type: "text" }],
			isError: false,
			role: "toolResult",
			timestamp: 0,
			toolCallId: requiredString(record, "tool_call_id"),
			toolName: "tool",
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
			parameters: schema(fn.parameters),
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

function schema(value: unknown): TSchema {
	readRecord(value);
	return Type.Object({}, { additionalProperties: true });
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
