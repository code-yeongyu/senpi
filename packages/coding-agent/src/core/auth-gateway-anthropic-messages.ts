import type { AssistantMessage, AssistantMessageEvent, Context, Message, Tool } from "@earendil-works/pi-ai/compat";
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

export type AnthropicMessagesGatewayAdapter = {
	handle(request: AuthGatewayAdapterRequest): Promise<AuthGatewayAdapterResponse>;
};

export function createAnthropicMessagesGatewayAdapter(options: {
	readonly provider: string;
	readonly runtime: AuthGatewayAdapterRuntime;
}): AnthropicMessagesGatewayAdapter {
	return {
		async handle(request) {
			try {
				const parsed = parseAnthropicRequest(request.body);
				const result = await options.runtime.stream({
					context: parsed.context,
					modelId: parsed.model,
					provider: options.provider,
					selector: selectorFromHeaders(request.headers),
					signal: request.signal,
				});
				if (result.kind === "model_not_found") return unknownModel();
				if (result.kind !== "stream") return safeError(result.statusCode);
				if (parsed.stream) return { frames: anthropicFrames(result.stream), kind: "sse", statusCode: 200 };
				return {
					body: anthropicCompletion(await result.stream.result(), result.model.id),
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

function parseAnthropicRequest(value: unknown): {
	readonly context: Context;
	readonly model: string;
	readonly stream: boolean;
} {
	const record = readRecord(value);
	exactKeys(record, ["max_tokens", "messages", "model", "stream", "system", "temperature", "tools"]);
	optionalNumber(record, "temperature");
	const maxTokens = optionalNumber(record, "max_tokens");
	if (maxTokens === undefined || maxTokens < 1 || !Number.isInteger(maxTokens))
		throw new AuthGatewayAdapterError("max_tokens");
	const systemPrompt = record.system === undefined ? undefined : parseSystem(record.system);
	return {
		context: {
			messages: requiredArray(record, "messages").flatMap(parseMessage),
			systemPrompt,
			tools: record.tools === undefined ? undefined : parseTools(record.tools),
		},
		model: requiredString(record, "model"),
		stream: optionalBoolean(record, "stream") ?? false,
	};
}

function parseSystem(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) throw new AuthGatewayAdapterError("system");
	return value
		.map((block) => {
			const record = readRecord(block);
			exactKeys(record, ["text", "type"]);
			if (record.type !== "text") throw new AuthGatewayAdapterError("system");
			return requiredString(record, "text");
		})
		.join("");
}

function parseMessage(value: unknown): readonly Message[] {
	const record = readRecord(value);
	exactKeys(record, ["content", "role"]);
	const role = requiredString(record, "role");
	if (role === "user") return parseUser(record.content);
	if (role === "assistant") return [parseAssistant(record.content)];
	throw new AuthGatewayAdapterError("messages.role");
}

function parseUser(content: unknown): readonly Message[] {
	if (typeof content === "string") return [{ content, role: "user", timestamp: 0 }];
	if (!Array.isArray(content)) throw new AuthGatewayAdapterError("messages.content");
	const messages: Message[] = [];
	let text = "";
	for (const block of content) {
		const record = readRecord(block);
		const type = requiredString(record, "type");
		if (type === "text") {
			exactKeys(record, ["text", "type"]);
			text += requiredString(record, "text");
			continue;
		}
		if (type === "tool_result") {
			exactKeys(record, ["content", "is_error", "tool_use_id", "type"]);
			const isError = record.is_error === undefined ? false : Boolean(record.is_error);
			if (text.length > 0) {
				messages.push({ content: text, role: "user", timestamp: 0 });
				text = "";
			}
			messages.push({
				content: [{ text: textBlock(record.content), type: "text" }],
				isError,
				role: "toolResult",
				timestamp: 0,
				toolCallId: requiredString(record, "tool_use_id"),
				toolName: "tool",
			});
			continue;
		}
		throw new AuthGatewayAdapterError("messages.content");
	}
	if (text.length > 0) messages.push({ content: text, role: "user", timestamp: 0 });
	return messages.length > 0 ? messages : [invalidContent()];
}

function parseAssistant(content: unknown): Message {
	if (typeof content === "string") return assistantMessage([{ text: content, type: "text" }]);
	if (!Array.isArray(content)) throw new AuthGatewayAdapterError("messages.content");
	const blocks: AssistantMessage["content"] = [];
	for (const block of content) {
		const record = readRecord(block);
		const type = requiredString(record, "type");
		if (type === "text") {
			exactKeys(record, ["text", "type"]);
			blocks.push({ text: requiredString(record, "text"), type: "text" });
			continue;
		}
		if (type === "thinking") {
			exactKeys(record, ["thinking", "type"]);
			blocks.push({ thinking: requiredString(record, "thinking"), type: "thinking" });
			continue;
		}
		if (type === "tool_use") {
			exactKeys(record, ["id", "input", "name", "type"]);
			blocks.push({
				arguments: readRecord(record.input),
				id: requiredString(record, "id"),
				name: requiredString(record, "name"),
				type: "toolCall",
			});
			continue;
		}
		throw new AuthGatewayAdapterError("messages.content");
	}
	return assistantMessage(blocks);
}

function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		api: "anthropic-messages",
		content,
		model: "gateway-history",
		provider: "gateway-history",
		role: "assistant",
		stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
		timestamp: 0,
		usage: zeroUsage(),
	};
}

function parseTools(value: unknown): Tool[] {
	if (!Array.isArray(value)) throw new AuthGatewayAdapterError("tools");
	return value.map((entry) => {
		const record = readRecord(entry);
		exactKeys(record, ["description", "input_schema", "name"]);
		return {
			description: requiredString(record, "description"),
			name: requiredString(record, "name"),
			parameters: parseToolSchema(record.input_schema),
		};
	});
}

function textBlock(value: unknown): string {
	return typeof value === "string" ? value : parseSystem(value);
}
function invalidContent(): never {
	throw new AuthGatewayAdapterError("messages.content");
}

function anthropicCompletion(message: AssistantMessage, model: string): unknown {
	return {
		content: anthropicBlocks(message),
		id: message.responseId ?? "gateway",
		model,
		role: "assistant",
		stop_reason: stopReason(message),
		type: "message",
		usage: { input_tokens: message.usage.input, output_tokens: message.usage.output },
	};
}

function anthropicBlocks(message: AssistantMessage): unknown[] {
	const output: unknown[] = [];
	for (const block of message.content) {
		if (block.type === "text") output.push({ text: block.text, type: "text" });
		if (block.type === "thinking") output.push({ thinking: block.thinking, type: "thinking" });
		if (block.type === "toolCall")
			output.push({ id: block.id, input: block.arguments, name: block.name, type: "tool_use" });
	}
	return output;
}

async function* anthropicFrames(stream: AsyncIterable<AssistantMessageEvent>) {
	yield { data: { message: { content: [], role: "assistant" }, type: "message_start" }, event: "message_start" };
	let pendingTool: { readonly contentIndex: number; deltas: string[] } | undefined;
	for await (const event of stream) {
		if (event.type === "text_start")
			yield {
				data: { content_block: { text: "", type: "text" }, index: event.contentIndex, type: "content_block_start" },
				event: "content_block_start",
			};
		if (event.type === "text_delta")
			yield {
				data: {
					delta: { text: event.delta, type: "text_delta" },
					index: event.contentIndex,
					type: "content_block_delta",
				},
				event: "content_block_delta",
			};
		if (event.type === "text_end")
			yield { data: { index: event.contentIndex, type: "content_block_stop" }, event: "content_block_stop" };
		if (event.type === "thinking_start")
			yield {
				data: {
					content_block: { thinking: "", type: "thinking" },
					index: event.contentIndex,
					type: "content_block_start",
				},
				event: "content_block_start",
			};
		if (event.type === "thinking_delta")
			yield {
				data: {
					delta: { thinking: event.delta, type: "thinking_delta" },
					index: event.contentIndex,
					type: "content_block_delta",
				},
				event: "content_block_delta",
			};
		if (event.type === "thinking_end")
			yield { data: { index: event.contentIndex, type: "content_block_stop" }, event: "content_block_stop" };
		if (event.type === "toolcall_start") pendingTool = { contentIndex: event.contentIndex, deltas: [] };
		if (event.type === "toolcall_delta") {
			if (pendingTool === undefined || pendingTool.contentIndex !== event.contentIndex) {
				pendingTool = { contentIndex: event.contentIndex, deltas: [] };
			}
			pendingTool.deltas.push(event.delta);
		}
		if (event.type === "toolcall_end") {
			const deltas = pendingTool?.contentIndex === event.contentIndex ? pendingTool.deltas.join("") : "";
			yield {
				data: {
					content_block: { id: event.toolCall.id, input: {}, name: event.toolCall.name, type: "tool_use" },
					index: event.contentIndex,
					type: "content_block_start",
				},
				event: "content_block_start",
			};
			if (deltas.length > 0)
				yield {
					data: {
						delta: { partial_json: deltas, type: "input_json_delta" },
						index: event.contentIndex,
						type: "content_block_delta",
					},
					event: "content_block_delta",
				};
			yield { data: { index: event.contentIndex, type: "content_block_stop" }, event: "content_block_stop" };
			pendingTool = undefined;
		}
		if (event.type === "done")
			yield {
				data: {
					delta: { stop_reason: stopReason(event.message) },
					type: "message_delta",
					usage: { output_tokens: event.message.usage.output },
				},
				event: "message_delta",
			};
		if (event.type === "error")
			yield {
				data: { error: { message: "Gateway provider unavailable", type: "api_error" }, type: "error" },
				event: "error",
			};
	}
	yield { data: { type: "message_stop" }, event: "message_stop" };
}

function stopReason(message: AssistantMessage): "end_turn" | "max_tokens" | "tool_use" {
	return message.stopReason === "length" ? "max_tokens" : message.stopReason === "toolUse" ? "tool_use" : "end_turn";
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
