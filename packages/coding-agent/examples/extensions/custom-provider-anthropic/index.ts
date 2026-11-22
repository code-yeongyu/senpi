/**
 * Custom Provider Example
 *
 * Demonstrates registering a custom provider with:
 * - Custom API identifier ("custom-anthropic-api")
 * - Custom streamSimple implementation
 * - API key support via environment variable
 * - Two model definitions
 *
 * Usage:
 *   # First install dependencies
 *   cd packages/coding-agent/examples/extensions/custom-provider && npm install
 *
 *   # With API key
 *   CUSTOM_ANTHROPIC_API_KEY=sk-ant-... senpi -e ./packages/coding-agent/examples/extensions/custom-provider
 *
 * Then use /model to select custom-anthropic/claude-sonnet-4-5
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ContentBlockParam, MessageCreateParamsStreaming } from "@anthropic-ai/sdk/resources/messages.js";
import type { ExtensionAPI } from "@code-yeongyu/senpi";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	calculateCost,
	collapseSystemMessages,
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	getCurrentTools,
	type ImageContent,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type StopReason,
	type TextContent,
	type ThinkingContent,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
	type TranscriptContext,
} from "@earendil-works/pi-ai";

// =============================================================================
// Streaming Implementation (simplified from packages/ai/src/api/anthropic-messages.ts)
// =============================================================================

function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

function convertContentBlocks(
	content: (TextContent | ImageContent)[],
): string | Array<{ type: "text"; text: string } | { type: "image"; source: any }> {
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) {
		return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
	}

	const blocks = content.map((block) => {
		if (block.type === "text") {
			return { type: "text" as const, text: sanitizeSurrogates(block.text) };
		}
		return {
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: block.mimeType,
				data: block.data,
			},
		};
	});

	if (!blocks.some((b) => b.type === "text")) {
		blocks.unshift({ type: "text" as const, text: "(see attached image)" });
	}

	return blocks;
}

function convertMessages(messages: Message[]): any[] {
	const params: any[] = [];

	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];

		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim()) {
					params.push({ role: "user", content: sanitizeSurrogates(msg.content) });
				}
			} else {
				const blocks: ContentBlockParam[] = msg.content.map((item) =>
					item.type === "text"
						? { type: "text" as const, text: sanitizeSurrogates(item.text) }
						: {
								type: "image" as const,
								source: { type: "base64" as const, media_type: item.mimeType as any, data: item.data },
							},
				);
				if (blocks.length > 0) {
					params.push({ role: "user", content: blocks });
				}
			}
		} else if (msg.role === "assistant") {
			const blocks: ContentBlockParam[] = [];
			for (const block of msg.content) {
				if (block.type === "text" && block.text.trim()) {
					blocks.push({ type: "text", text: sanitizeSurrogates(block.text) });
				} else if (block.type === "thinking" && block.thinking.trim()) {
					if ((block as ThinkingContent).thinkingSignature) {
						blocks.push({
							type: "thinking" as any,
							thinking: sanitizeSurrogates(block.thinking),
							signature: (block as ThinkingContent).thinkingSignature!,
						});
					} else {
						blocks.push({ type: "text", text: sanitizeSurrogates(block.thinking) });
					}
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: block.name,
						input: block.arguments,
					});
				}
			}
			if (blocks.length > 0) {
				params.push({ role: "assistant", content: blocks });
			}
		} else if (msg.role === "toolResult") {
			const toolResults: any[] = [];
			toolResults.push({
				type: "tool_result",
				tool_use_id: msg.toolCallId,
				content: convertContentBlocks(msg.content),
				is_error: msg.isError,
			});

			let j = i + 1;
			while (j < messages.length && messages[j].role === "toolResult") {
				const nextMsg = messages[j] as ToolResultMessage;
				toolResults.push({
					type: "tool_result",
					tool_use_id: nextMsg.toolCallId,
					content: convertContentBlocks(nextMsg.content),
					is_error: nextMsg.isError,
				});
				j++;
			}
			i = j - 1;
			params.push({ role: "user", content: toolResults });
		}
	}

	// Add cache control to last user message
	if (params.length > 0) {
		const last = params[params.length - 1];
		if (last.role === "user" && Array.isArray(last.content)) {
			const lastBlock = last.content[last.content.length - 1];
			if (lastBlock) {
				lastBlock.cache_control = { type: "ephemeral" };
			}
		}
	}

	return params;
}

function convertTools(tools: Tool[]): any[] {
	return tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
		input_schema: {
			type: "object",
			properties: (tool.parameters as any).properties || {},
			required: (tool.parameters as any).required || [],
		},
	}));
}

function mapStopReason(reason: string): StopReason {
	switch (reason) {
		case "end_turn":
		case "pause_turn":
		case "stop_sequence":
			return "stop";
		case "max_tokens":
			return "length";
		case "tool_use":
			return "toolUse";
		default:
			return "error";
	}
}

function streamCustomAnthropic(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	// The transcript carries the prompt and tools in its system messages. This provider sends
	// one top-level system prompt, so fold later system messages into the leading one first.
	const transcript = collapseSystemMessages(context);
	const systemPrompt = getCurrentSystemPrompt(transcript.messages);
	const tools = getCurrentTools(transcript.messages);

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "pending",
			timestamp: Date.now(),
		};

		try {
			const apiKey = options?.apiKey ?? "";
			const betaFeatures = ["fine-grained-tool-streaming-2025-05-14", "interleaved-thinking-2025-05-14"];
			const clientOptions: any = {
				baseURL: model.baseUrl,
				dangerouslyAllowBrowser: true,
				apiKey,
				defaultHeaders: {
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					"anthropic-beta": betaFeatures.join(","),
				},
			};

			const client = new Anthropic(clientOptions);

			// Build request params
			const params: MessageCreateParamsStreaming = {
				model: model.id,
				messages: convertMessages(transcript.messages),
				max_tokens: options?.maxTokens || Math.floor(model.maxTokens / 3),
				stream: true,
			};

			if (systemPrompt) {
				params.system = [
					{
						type: "text",
						text: sanitizeSurrogates(systemPrompt),
						cache_control: { type: "ephemeral" },
					},
				];
			}

			if (tools.length > 0) {
				params.tools = convertTools(tools);
			}

			// Handle thinking/reasoning
			if (options?.reasoning && model.reasoning) {
				const defaultBudgets: Record<string, number> = {
					minimal: 1024,
					low: 4096,
					medium: 10240,
					high: 20480,
				};
				const customBudget = options.thinkingBudgets?.[options.reasoning as keyof typeof options.thinkingBudgets];
				params.thinking = {
					type: "enabled",
					budget_tokens: customBudget ?? defaultBudgets[options.reasoning] ?? 10240,
				};
			}

			const anthropicStream = client.messages.stream({ ...params }, { signal: options?.signal });
			stream.push({ type: "start", partial: output });

			type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & { index: number };
			const blocks = output.content as Block[];

			for await (const event of anthropicStream) {
				if (event.type === "message_start") {
					output.usage.input = event.message.usage.input_tokens || 0;
					output.usage.output = event.message.usage.output_tokens || 0;
					output.usage.cacheRead = (event.message.usage as any).cache_read_input_tokens || 0;
					output.usage.cacheWrite = (event.message.usage as any).cache_creation_input_tokens || 0;
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
				} else if (event.type === "content_block_start") {
					if (event.content_block.type === "text") {
						output.content.push({ type: "text", text: "", index: event.index } as any);
						stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "thinking") {
						output.content.push({
							type: "thinking",
							thinking: "",
							thinkingSignature: "",
							index: event.index,
						} as any);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "tool_use") {
						output.content.push({
							type: "toolCall",
							id: event.content_block.id,
							name: event.content_block.name,
							arguments: {},
							partialJson: "",
							index: event.index,
						} as any);
						stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
					}
				} else if (event.type === "content_block_delta") {
					const index = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[index];
					if (!block) continue;

					if (event.delta.type === "text_delta" && block.type === "text") {
						block.text += event.delta.text;
						stream.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: output });
					} else if (event.delta.type === "thinking_delta" && block.type === "thinking") {
						block.thinking += event.delta.thinking;
						stream.push({
							type: "thinking_delta",
							contentIndex: index,
							delta: event.delta.thinking,
							partial: output,
						});
					} else if (event.delta.type === "input_json_delta" && block.type === "toolCall") {
						(block as any).partialJson += event.delta.partial_json;
						try {
							block.arguments = JSON.parse((block as any).partialJson);
						} catch {}
						stream.push({
							type: "toolcall_delta",
							contentIndex: index,
							delta: event.delta.partial_json,
							partial: output,
						});
					} else if (event.delta.type === "signature_delta" && block.type === "thinking") {
						block.thinkingSignature = (block.thinkingSignature || "") + (event.delta as any).signature;
					}
				} else if (event.type === "content_block_stop") {
					const index = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[index];
					if (!block) continue;

					delete (block as any).index;
					if (block.type === "text") {
						stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
					} else if (block.type === "thinking") {
						stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
					} else if (block.type === "toolCall") {
						try {
							block.arguments = JSON.parse((block as any).partialJson);
						} catch {}
						delete (block as any).partialJson;
						stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
					}
				} else if (event.type === "message_delta") {
					if ((event.delta as any).stop_reason) {
						output.stopReason = mapStopReason((event.delta as any).stop_reason);
					}
					output.usage.input = (event.usage as any).input_tokens || 0;
					output.usage.output = (event.usage as any).output_tokens || 0;
					output.usage.cacheRead = (event.usage as any).cache_read_input_tokens || 0;
					output.usage.cacheWrite = (event.usage as any).cache_creation_input_tokens || 0;
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
				}
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}
			if (output.stopReason === "pending") {
				throw new Error("Anthropic stream ended without a stop reason");
			}
			if (output.stopReason === "error" || output.stopReason === "aborted") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) delete (block as any).index;
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default function (pi: ExtensionAPI) {
	pi.registerProvider("custom-anthropic", {
		baseUrl: "https://api.anthropic.com",
		apiKey: "$CUSTOM_ANTHROPIC_API_KEY",
		api: "custom-anthropic-api",

		models: [
			{
				id: "claude-opus-4-5",
				name: "Claude Opus 4.5 (Custom)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
				contextWindow: 200000,
				maxTokens: 64000,
			},
			{
				id: "claude-sonnet-4-5",
				name: "Claude Sonnet 4.5 (Custom)",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200000,
				maxTokens: 64000,
			},
		],

		streamSimple: streamCustomAnthropic,
	});
}
