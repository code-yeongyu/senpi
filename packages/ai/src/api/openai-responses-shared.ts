import type OpenAI from "openai";
import type {
	ResponseInputItem as OpenAIResponseInputItem,
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseFunctionCallOutputItemList,
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputText,
	ResponseOutputItem,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStreamEvent,
	ResponseToolSearchOutputItemParam,
} from "openai/resources/responses/responses.js";
import {
	CONTEXT_PROVENANCE_FIELD,
	type ContextProvenance,
	contextProvenanceFingerprint,
	getContextProvenance,
} from "../context-provenance.ts";
import { calculateCost } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	ProviderNativeContent,
	StopReason,
	TextContent,
	TextSignatureV1,
	ThinkingContent,
	Tool,
	ToolCall,
	Usage,
} from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import {
	appendGrammarToolInputJsonDelta,
	type GrammarToolInputJsonBuffer,
	getGrammarToolInput,
	resolveGrammarConstrainedSampling,
	resolveJsonSchemaStrictSampling,
} from "./constrained-sampling.ts";
import { transformMessages } from "./transform-messages.ts";

// =============================================================================
// Utilities
// =============================================================================

function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
	const payload: TextSignatureV1 = { v: 1, id };
	if (phase) payload.phase = phase;
	return JSON.stringify(payload);
}

function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			if (parsed.v === 1 && typeof parsed.id === "string") {
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					return { id: parsed.id, phase: parsed.phase };
				}
				return { id: parsed.id };
			}
		} catch {
			// Fall through to legacy plain-string handling.
		}
	}
	return { id: signature };
}

/**
 * Parse a persisted reasoning-item signature, rejecting anything that is not a
 * genuine Responses reasoning item. Foreign providers store non-JSON markers
 * (Kimi's "reasoning_content") or opaque payloads (Anthropic signatures) in
 * the same field; an unguarded JSON.parse turns a provenance mix-up into a
 * client-side throw, and blindly pushing the parsed value leaks invalid items.
 */
function parseReasoningSignature(signature: string | undefined): ResponseReasoningItem | undefined {
	if (!signature) return undefined;
	try {
		const parsed = JSON.parse(signature) as ResponseReasoningItem;
		return parsed?.type === "reasoning" ? parsed : undefined;
	} catch {
		return undefined;
	}
}

type ToolResultOutputContent = Array<ResponseInputText | ResponseInputImage>;

function convertToolResultOutput<TApi extends Api>(
	model: Model<TApi>,
	content: readonly (TextContent | ImageContent)[],
): string | ToolResultOutputContent {
	const textResult = content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("\n");
	const images = content.filter((c): c is ImageContent => c.type === "image");
	const hasText = textResult.length > 0;

	if (images.length === 0 || !model.input.includes("image")) {
		return sanitizeSurrogates(hasText ? textResult : images.length > 0 ? "(see attached image)" : "(no tool output)");
	}

	const output: ToolResultOutputContent = [];
	if (hasText) {
		output.push({ type: "input_text", text: sanitizeSurrogates(textResult) });
	}
	for (const image of images) {
		output.push({
			type: "input_image",
			detail: "auto",
			image_url: `data:${image.mimeType};base64,${image.data}`,
		});
	}
	return output;
}

export interface OpenAIResponsesStreamOptions {
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	grammarToolInputProperties?: ReadonlyMap<string, string>;
	resolveServiceTier?: (
		responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
		requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => ResponseCreateParamsStreaming["service_tier"] | undefined;
	applyServiceTierPricing?: (
		usage: Usage,
		serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => void;
}

export interface ConvertResponsesMessagesOptions {
	includeSystemPrompt?: boolean;
	preserveThinking?: boolean;
	preserveTextSignatures?: boolean;
	grammarToolInputProperties?: ReadonlyMap<string, string>;
	deferredTools?: ReadonlyMap<string, Tool>;
	toolOptions?: ConvertResponsesToolsOptions;
	/** Internal request-local provenance sealing pass. Never serialized to provider payloads. */
	sealContextProvenance?: boolean;
}

export interface ConvertResponsesToolsOptions {
	strict?: boolean | null;
	supportsStrictMode?: boolean;
	supportsOpenAIGrammarTools?: boolean;
	deferLoading?: boolean;
}

type ResponseCustomToolCallItem = {
	type: "custom_tool_call";
	id?: string;
	call_id: string;
	name: string;
	input?: string;
};

type ResponseCustomToolCallOutputItem = {
	type: "custom_tool_call_output";
	call_id: string;
	name?: string;
	output: string | ResponseFunctionCallOutputItemList;
};

type ResponseInputItem = OpenAIResponseInputItem | ResponseCustomToolCallItem | ResponseCustomToolCallOutputItem;

export const CUSTOM_TOOL_CALL_ITEM_ID_SENTINEL = "custom";

type ResponseFunctionTool = Extract<OpenAITool, { type: "function" }>;

function isResponseCustomToolCallItem(item: { type?: string }): item is ResponseCustomToolCallItem {
	return item.type === "custom_tool_call";
}

function isFreeformTool(tool: Tool): boolean {
	return tool.freeform !== undefined;
}

function isFreeformToolName(toolName: string, tools: Tool[] | undefined): boolean {
	return tools?.some((tool) => tool.name === toolName && isFreeformTool(tool)) ?? false;
}

function getFreeformToolInput(argumentsValue: Record<string, unknown>): string {
	return typeof argumentsValue.input === "string" ? argumentsValue.input : JSON.stringify(argumentsValue);
}

function contextProvenanceForInput(message: unknown, seal: boolean | undefined): ContextProvenance | undefined {
	const provenance = getContextProvenance(message);
	if (!provenance) return undefined;
	const fingerprint = contextProvenanceFingerprint(message);
	if (fingerprint === undefined) return undefined;
	const stored = provenance.integrity;
	if (stored === undefined && seal) {
		provenance.integrity = fingerprint;
		return provenance;
	}
	return stored === fingerprint ? provenance : undefined;
}

function withContextProvenance<T extends object>(item: T, message: unknown, seal: boolean | undefined): T {
	const provenance = contextProvenanceForInput(message, seal);
	if (provenance) {
		Object.defineProperty(item, CONTEXT_PROVENANCE_FIELD, {
			value: provenance,
			enumerable: false,
		});
	}
	return item;
}
// =============================================================================
// Message conversion
// =============================================================================

export function convertResponsesMessages<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	allowedToolCallProviders: ReadonlySet<string>,
	options?: ConvertResponsesMessagesOptions,
): ResponseInput {
	const messages: ResponseInputItem[] = [];
	const loadedToolNames = new Set<string>();

	const normalizeIdPart = (part: string): string => {
		const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
		const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
		return normalized.replace(/_+$/, "");
	};

	const buildForeignResponsesItemId = (itemId: string): string => {
		const normalized = `fc_${shortHash(itemId)}`;
		return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
	};

	const normalizeToolCallId = (id: string, _targetModel: Model<TApi>, source: AssistantMessage): string => {
		if (!id.includes("|")) return normalizeIdPart(id);
		const [callId, itemId] = id.split("|");
		const normalizedCallId = normalizeIdPart(callId);
		if (itemId === CUSTOM_TOOL_CALL_ITEM_ID_SENTINEL) {
			return `${normalizedCallId}|${CUSTOM_TOOL_CALL_ITEM_ID_SENTINEL}`;
		}
		if (!allowedToolCallProviders.has(model.provider)) return normalizeIdPart(id);
		const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
		let normalizedItemId = isForeignToolCall ? buildForeignResponsesItemId(itemId) : normalizeIdPart(itemId);
		// OpenAI Responses API requires item id to start with "fc"
		if (!normalizedItemId.startsWith("fc_")) {
			normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
		}
		return `${normalizedCallId}|${normalizedItemId}`;
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId, {
		preserveThinking: options?.preserveThinking,
		preserveTextSignatures: options?.preserveTextSignatures,
	});

	const includeSystemPrompt = options?.includeSystemPrompt ?? true;
	if (includeSystemPrompt && context.systemPrompt) {
		const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined;
		const role = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";
		messages.push({
			role,
			content: sanitizeSurrogates(context.systemPrompt),
		});
	}

	let msgIndex = 0;
	for (const msg of transformedMessages) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				messages.push(
					withContextProvenance(
						{
							role: "user",
							content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
						},
						msg,
						options?.sealContextProvenance,
					),
				);
			} else {
				const content: ResponseInputContent[] = msg.content.map((item): ResponseInputContent => {
					if (item.type === "text") {
						return {
							type: "input_text",
							text: sanitizeSurrogates(item.text),
						} satisfies ResponseInputText;
					}
					return {
						type: "input_image",
						detail: "auto",
						image_url: `data:${item.mimeType};base64,${item.data}`,
					} satisfies ResponseInputImage;
				});
				if (content.length === 0) continue;
				messages.push(withContextProvenance({ role: "user", content }, msg, options?.sealContextProvenance));
			}
		} else if (msg.role === "assistant") {
			const output: ResponseInputItem[] = [];
			const assistantMsg = msg as AssistantMessage;
			const isDifferentModel =
				assistantMsg.model !== model.id &&
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api;
			let textBlockIndex = 0;

			const pushAssistantText = (text: string, textSignature?: string): void => {
				const parsedSignature = parseTextSignature(textSignature);
				const fallbackMessageId =
					textBlockIndex === 0 ? `msg_pi_${msgIndex}` : `msg_pi_${msgIndex}_${textBlockIndex}`;
				textBlockIndex++;
				// OpenAI requires id to be max 64 characters
				let msgId = parsedSignature?.id;
				if (!msgId) {
					msgId = fallbackMessageId;
				} else if (msgId.length > 64) {
					msgId = `msg_${shortHash(msgId)}`;
				}
				output.push({
					type: "message",
					role: "assistant",
					content: [{ type: "output_text", text: sanitizeSurrogates(text), annotations: [] }],
					status: "completed",
					id: msgId,
					phase: parsedSignature?.phase,
				} satisfies ResponseOutputMessage);
			};

			for (const block of msg.content) {
				if (block.type === "thinking") {
					const reasoningItem = parseReasoningSignature(block.thinkingSignature);
					if (reasoningItem) {
						output.push(reasoningItem);
					} else if (block.thinkingSignature && block.thinking.trim() !== "") {
						// A signed thinking block whose signature is not a real reasoning
						// item (foreign provenance or corrupted state): demote to plain
						// text, mirroring the cross-model policy in transformMessages.
						pushAssistantText(block.thinking);
					}
					// Signed foreign blocks with no text are intentionally dropped.
				} else if (block.type === "providerNative") {
				} else if (block.type === "text") {
					const textBlock = block as TextContent;
					pushAssistantText(textBlock.text, textBlock.textSignature);
				} else if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					const [callId, itemIdRaw] = toolCall.id.split("|");
					const customInputProperty = options?.grammarToolInputProperties?.get(toolCall.name);
					const isPersistedFreeform = itemIdRaw === CUSTOM_TOOL_CALL_ITEM_ID_SENTINEL;
					const isFreeform = isFreeformToolName(toolCall.name, context.tools) || isPersistedFreeform;
					let itemId: string | undefined = isPersistedFreeform ? undefined : itemIdRaw;

					// An active grammar declaration wins over sentinel recovery below: its
					// named input property is richer than the persisted freeform fallback.

					// For different-model messages, set id to undefined to avoid pairing validation.
					// OpenAI tracks which fc_xxx IDs were paired with rs_xxx reasoning items.
					// By omitting the id, we avoid triggering that validation (like cross-provider does).
					// Function-call item ids must begin with fc_ while freeform calls can replay
					// without the local <call_id>|custom sentinel.
					if (
						(isDifferentModel && itemId?.startsWith("fc_")) ||
						(!isFreeform && customInputProperty === undefined && !itemId?.startsWith("fc_"))
					) {
						itemId = undefined;
					}

					if (customInputProperty !== undefined) {
						output.push({
							type: "custom_tool_call",
							...(itemId !== undefined ? { id: itemId } : {}),
							call_id: callId,
							name: toolCall.name,
							input: sanitizeSurrogates(
								getGrammarToolInput(toolCall.name, toolCall.arguments, customInputProperty),
							),
						} satisfies ResponseCustomToolCallItem);
					} else if (isFreeform) {
						output.push({
							type: "custom_tool_call",
							call_id: callId,
							name: toolCall.name,
							input: getFreeformToolInput(toolCall.arguments),
						} satisfies ResponseCustomToolCallItem);
					} else {
						output.push({
							type: "function_call",
							...(itemId?.startsWith("fc_") ? { id: itemId } : {}),
							call_id: callId,
							name: toolCall.name,
							arguments: JSON.stringify(toolCall.arguments),
						});
					}
				}
			}
			if (output.length === 0) continue;
			messages.push(...output.map((item) => withContextProvenance(item, msg, options?.sealContextProvenance)));
		} else if (msg.role === "toolResult") {
			const [callId, itemIdRaw] = msg.toolCallId.split("|");
			const output = convertToolResultOutput(model, msg.content);
			const customInputProperty = options?.grammarToolInputProperties?.get(msg.toolName);
			const isPersistedFreeform = itemIdRaw === CUSTOM_TOOL_CALL_ITEM_ID_SENTINEL;

			if (customInputProperty !== undefined) {
				messages.push(
					withContextProvenance(
						{
							type: "custom_tool_call_output",
							call_id: callId,
							output,
						} satisfies ResponseCustomToolCallOutputItem,
						msg,
						options?.sealContextProvenance,
					),
				);
			} else if (isFreeformToolName(msg.toolName, context.tools) || isPersistedFreeform) {
				messages.push(
					withContextProvenance(
						{
							type: "custom_tool_call_output",
							call_id: callId,
							name: msg.toolName,
							output,
						} satisfies ResponseCustomToolCallOutputItem,
						msg,
						options?.sealContextProvenance,
					),
				);
			} else {
				messages.push(
					withContextProvenance(
						{ type: "function_call_output", call_id: callId, output },
						msg,
						options?.sealContextProvenance,
					),
				);
			}
			const deferredTools: Tool[] = [];
			for (const name of msg.addedToolNames ?? []) {
				const tool = options?.deferredTools?.get(name);
				if (!tool || loadedToolNames.has(name)) continue;
				loadedToolNames.add(name);
				deferredTools.push(tool);
			}
			if (deferredTools.length > 0) {
				const names = deferredTools.map((tool) => tool.name);
				const searchCallId = `pi_tool_load_${shortHash(`${msg.toolCallId}:${names.join(",")}`)}`;
				messages.push(
					withContextProvenance(
						{
							type: "tool_search_call",
							call_id: searchCallId,
							execution: "client",
							status: "completed",
							arguments: { query: names.join(" "), limit: names.length },
						} satisfies ResponseInputItem,
						msg,
						options?.sealContextProvenance,
					),
				);
				messages.push(
					withContextProvenance(
						{
							type: "tool_search_output",
							call_id: searchCallId,
							execution: "client",
							status: "completed",
							tools: convertResponsesTools(deferredTools, {
								...options?.toolOptions,
								deferLoading: true,
							}),
						} satisfies ResponseToolSearchOutputItemParam,
						msg,
						options?.sealContextProvenance,
					),
				);
			}
		}
		msgIndex++;
	}

	return messages as ResponseInput;
}

// =============================================================================
// Tool conversion
// =============================================================================

export function convertResponsesTools(tools: readonly Tool[], options?: ConvertResponsesToolsOptions): OpenAITool[] {
	const defaultStrict = options?.strict === undefined ? false : options.strict;
	const supportsStrictMode = options?.supportsStrictMode ?? true;
	const supportsOpenAIGrammarTools = options?.supportsOpenAIGrammarTools ?? false;

	return tools.map((tool) => {
		const grammar = resolveGrammarConstrainedSampling(tool, supportsOpenAIGrammarTools);
		if (grammar) {
			return {
				type: "custom",
				name: tool.name,
				description: tool.description,
				format: {
					type: "grammar",
					syntax: grammar.format,
					definition: grammar.definition,
				},
				...(options?.deferLoading ? { defer_loading: true } : {}),
			} satisfies OpenAITool;
		}
		if (tool.freeform) {
			return {
				type: "custom",
				name: tool.name,
				description: tool.description,
				format: tool.freeform,
				...(options?.deferLoading ? { defer_loading: true } : {}),
			} as OpenAITool;
		}

		const constrainedStrict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
		const functionTool: Omit<ResponseFunctionTool, "strict"> & {
			strict?: ResponseFunctionTool["strict"];
		} = {
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters as ResponseFunctionTool["parameters"], // TypeBox already generates JSON Schema
			...(options?.deferLoading ? { defer_loading: true } : {}),
		};
		if (supportsStrictMode) {
			functionTool.strict = constrainedStrict ?? defaultStrict;
		}
		return functionTool as OpenAITool;
	});
}

// =============================================================================
// Stream processing
// =============================================================================

type StreamingToolCall = ToolCall & {
	partialJson?: string;
	customInput?: {
		property: string;
		jsonBuffer: GrammarToolInputJsonBuffer;
	};
};

function getCustomToolCallInput(block: StreamingToolCall): string {
	const property = block.customInput?.property;
	if (property === undefined) return "";
	const value = block.arguments[property];
	return typeof value === "string" ? value : "";
}

function appendCustomToolCallInput(block: StreamingToolCall, nextInput: string, close: boolean): string | undefined {
	const customInput = block.customInput;
	if (!customInput) return undefined;
	const delta = appendGrammarToolInputJsonDelta(customInput.jsonBuffer, customInput.property, nextInput, close);
	block.arguments = { [customInput.property]: nextInput };
	return delta;
}

type ResponsesOutputSlot =
	| { type: "thinking"; block: ThinkingContent; contentIndex: number }
	| { type: "text"; block: TextContent; contentIndex: number }
	| { type: "toolCall"; block: StreamingToolCall; contentIndex: number }
	| { type: "providerNative"; block: ProviderNativeContent; contentIndex: number };

type ToolCallOutputSlot = Extract<ResponsesOutputSlot, { type: "toolCall" }>;

export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options?: OpenAIResponsesStreamOptions,
): Promise<void> {
	let sawTerminalResponseEvent = false;
	const outputSlots = new Map<number, ResponsesOutputSlot>();
	const reasoningBlocksById = new Map<string, ThinkingContent>();
	const applyMessagePhaseStopReason = (item: ResponseOutputItem): void => {
		if (item.type === "message" && item.phase === "final_answer") {
			output.stopReason = "stop";
		}
	};
	const getSlot = <TType extends ResponsesOutputSlot["type"]>(
		outputIndex: number,
		type: TType,
	): Extract<ResponsesOutputSlot, { type: TType }> | undefined => {
		const slot = outputSlots.get(outputIndex);
		return slot?.type === type ? (slot as Extract<ResponsesOutputSlot, { type: TType }>) : undefined;
	};
	const pushToolCallDelta = (slot: ToolCallOutputSlot, delta: string | undefined): void => {
		if (delta === undefined) return;
		stream.push({
			type: "toolcall_delta",
			contentIndex: slot.contentIndex,
			delta,
			partial: output,
		});
	};
	const createSlot = (
		outputIndex: number,
		item: ResponseOutputItem | ResponseCustomToolCallItem,
	): ResponsesOutputSlot | undefined => {
		if (item.type === "reasoning") {
			const block: ThinkingContent = { type: "thinking", thinking: "" };
			output.content.push(block);
			const slot = {
				type: "thinking",
				block,
				contentIndex: output.content.length - 1,
			} satisfies ResponsesOutputSlot;
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "thinking_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		if (item.type === "message") {
			applyMessagePhaseStopReason(item);
			const block: TextContent = { type: "text", text: "" };
			output.content.push(block);
			const slot = { type: "text", block, contentIndex: output.content.length - 1 } satisfies ResponsesOutputSlot;
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "text_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		if (item.type === "function_call") {
			const block: StreamingToolCall = {
				type: "toolCall",
				id: `${item.call_id}|${item.id}`,
				name: item.name,
				arguments: {},
				partialJson: item.arguments || "",
			};
			output.content.push(block);
			const slot = {
				type: "toolCall",
				block,
				contentIndex: output.content.length - 1,
			} satisfies ResponsesOutputSlot;
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		if (isResponseCustomToolCallItem(item)) {
			const inputProperty = options?.grammarToolInputProperties?.get(item.name) ?? "input";
			const input = item.input || "";
			const block: StreamingToolCall = {
				type: "toolCall",
				id: `${item.call_id}|${item.id ?? CUSTOM_TOOL_CALL_ITEM_ID_SENTINEL}`,
				name: item.name,
				arguments: { [inputProperty]: input },
				customInput: {
					property: inputProperty,
					jsonBuffer: { input: "", started: false, closed: false },
				},
			};
			output.content.push(block);
			const slot = {
				type: "toolCall",
				block,
				contentIndex: output.content.length - 1,
			} satisfies ResponsesOutputSlot;
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		const block = { type: "providerNative", subtype: item.type, raw: item } satisfies ProviderNativeContent;
		output.content.push(block);
		const slot = {
			type: "providerNative",
			block,
			contentIndex: output.content.length - 1,
		} satisfies ResponsesOutputSlot;
		outputSlots.set(outputIndex, slot);
		return slot;
	};
	const getOrCreateSlot = (
		outputIndex: number,
		item: ResponseOutputItem | ResponseCustomToolCallItem,
	): ResponsesOutputSlot | undefined => {
		return outputSlots.get(outputIndex) ?? createSlot(outputIndex, item);
	};
	// Azure OpenAI can omit reasoning.encrypted_content from response.output_item.done
	// and provide it only in response.completed.response.output. Backfill the
	// persisted reasoning signature from the terminal response to keep store:false
	// multi-turn replay stateless. See https://github.com/earendil-works/pi/issues/6409.
	const backfillReasoningSignatures = (responseOutput: ResponseOutputItem[]): void => {
		for (const item of responseOutput) {
			if (item.type !== "reasoning" || !item.encrypted_content) continue;
			const block = reasoningBlocksById.get(item.id);
			if (!block?.thinkingSignature) continue;

			const storedItem = parseReasoningSignature(block.thinkingSignature);
			if (!storedItem || storedItem.encrypted_content) continue;
			block.thinkingSignature = JSON.stringify({
				...storedItem,
				encrypted_content: item.encrypted_content,
			});
		}
	};
	const finalizeResponse = (
		response: Extract<ResponseStreamEvent, { type: "response.completed" | "response.incomplete" }>["response"],
	) => {
		sawTerminalResponseEvent = true;
		backfillReasoningSignatures(response.output ?? []);
		if (response?.id) {
			output.responseId = response.id;
		}
		if (response?.usage) {
			const inputDetails = response.usage.input_tokens_details as
				| { cached_tokens?: number; cache_write_tokens?: number }
				| undefined;
			const cachedTokens = inputDetails?.cached_tokens || 0;
			const cacheWriteTokens = inputDetails?.cache_write_tokens || 0;
			output.usage = {
				// OpenAI includes cached and cache-write tokens in input_tokens, so subtract both.
				input: Math.max(0, (response.usage.input_tokens || 0) - cachedTokens - cacheWriteTokens),
				output: response.usage.output_tokens || 0,
				cacheRead: cachedTokens,
				cacheWrite: cacheWriteTokens,
				reasoning: response.usage.output_tokens_details?.reasoning_tokens || 0,
				totalTokens: response.usage.total_tokens || 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
		}
		calculateCost(model, output.usage);
		if (options?.applyServiceTierPricing) {
			const serviceTier = options.resolveServiceTier
				? options.resolveServiceTier(response?.service_tier, options.serviceTier)
				: (response?.service_tier ?? options.serviceTier);
			options.applyServiceTierPricing(output.usage, serviceTier);
		}
		// Map status to stop reason
		const status = response?.status;
		output.rawStopReason = status;
		output.stopReason = mapStopReason(status);
		if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
			output.stopReason = "toolUse";
		}
	};

	for await (const event of openaiStream) {
		if (event.type === "response.created") {
			output.responseId = event.response.id;
		} else if (event.type === "response.output_item.added") {
			createSlot(event.output_index, event.item);
		} else if (event.type === "response.reasoning_summary_text.delta") {
			const slot = getSlot(event.output_index, "thinking");
			if (!slot) continue;
			slot.block.thinking += event.delta;
			stream.push({
				type: "thinking_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.reasoning_summary_part.done") {
			const slot = getSlot(event.output_index, "thinking");
			if (!slot) continue;
			slot.block.thinking += "\n\n";
			stream.push({
				type: "thinking_delta",
				contentIndex: slot.contentIndex,
				delta: "\n\n",
				partial: output,
			});
		} else if (event.type === "response.reasoning_text.delta") {
			const slot = getSlot(event.output_index, "thinking");
			if (!slot) continue;
			slot.block.thinking += event.delta;
			stream.push({
				type: "thinking_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.output_text.delta") {
			const slot = getSlot(event.output_index, "text");
			if (!slot) continue;
			slot.block.text += event.delta;
			stream.push({
				type: "text_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.refusal.delta") {
			const slot = getSlot(event.output_index, "text");
			if (!slot) continue;
			slot.block.text += event.delta;
			stream.push({
				type: "text_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.function_call_arguments.delta") {
			const slot = getSlot(event.output_index, "toolCall");
			if (!slot || slot.block.partialJson === undefined) continue;
			slot.block.partialJson += event.delta;
			slot.block.arguments = parseStreamingJson(slot.block.partialJson);
			pushToolCallDelta(slot, event.delta);
		} else if (event.type === "response.function_call_arguments.done") {
			const slot = getSlot(event.output_index, "toolCall");
			if (!slot || slot.block.partialJson === undefined) continue;
			const previousPartialJson = slot.block.partialJson;
			slot.block.partialJson = event.arguments;
			slot.block.arguments = parseStreamingJson(slot.block.partialJson);

			if (event.arguments.startsWith(previousPartialJson)) {
				const delta = event.arguments.slice(previousPartialJson.length);
				if (delta.length > 0) pushToolCallDelta(slot, delta);
			}
		} else if (event.type === "response.custom_tool_call_input.delta") {
			const slot = getSlot(event.output_index, "toolCall");
			if (!slot?.block.customInput) continue;
			pushToolCallDelta(
				slot,
				appendCustomToolCallInput(slot.block, getCustomToolCallInput(slot.block) + event.delta, false),
			);
		} else if (event.type === "response.custom_tool_call_input.done") {
			const slot = getSlot(event.output_index, "toolCall");
			if (!slot?.block.customInput) continue;
			pushToolCallDelta(slot, appendCustomToolCallInput(slot.block, event.input, true));
		} else if (event.type === "response.output_item.done") {
			const item = event.item;
			applyMessagePhaseStopReason(item);
			const slot = getOrCreateSlot(event.output_index, item);

			if (item.type === "reasoning" && slot?.type === "thinking") {
				const summaryText = item.summary?.map((s) => s.text).join("\n\n") || "";
				const contentText = item.content?.map((c) => c.text).join("\n\n") || "";
				slot.block.thinking = summaryText || contentText || slot.block.thinking;
				slot.block.thinkingSignature = JSON.stringify(item);
				reasoningBlocksById.set(item.id, slot.block);
				stream.push({
					type: "thinking_end",
					contentIndex: slot.contentIndex,
					content: slot.block.thinking,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			} else if (item.type === "message" && slot?.type === "text") {
				slot.block.text = item.content?.map((c) => (c.type === "output_text" ? c.text : c.refusal)).join("") || "";
				slot.block.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
				stream.push({
					type: "text_end",
					contentIndex: slot.contentIndex,
					content: slot.block.text,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			} else if (
				item.type === "function_call" &&
				slot?.type === "toolCall" &&
				slot.block.partialJson !== undefined
			) {
				slot.block.arguments = parseStreamingJson(item.arguments || slot.block.partialJson || "{}");
				// Finalize in-place and strip the scratch buffer so replay only
				// carries parsed arguments.
				delete slot.block.partialJson;
				stream.push({
					type: "toolcall_end",
					contentIndex: slot.contentIndex,
					toolCall: slot.block,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			} else if (item.type === "custom_tool_call" && slot?.type === "toolCall" && slot.block.customInput) {
				pushToolCallDelta(
					slot,
					appendCustomToolCallInput(slot.block, item.input ?? getCustomToolCallInput(slot.block), true),
				);
				delete slot.block.customInput;
				stream.push({
					type: "toolcall_end",
					contentIndex: slot.contentIndex,
					toolCall: slot.block,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			} else if (isResponseCustomToolCallItem(item) && slot?.type === "toolCall") {
				const input = typeof item.input === "string" ? item.input : "";
				slot.block.arguments = { input };
				delete (slot.block as { partialJson?: string }).partialJson;
				stream.push({
					type: "toolcall_end",
					contentIndex: slot.contentIndex,
					toolCall: slot.block,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			} else if (slot?.type === "providerNative") {
				slot.block.subtype = item.type;
				slot.block.raw = item;
				outputSlots.delete(event.output_index);
			}
		} else if (event.type === "response.completed" || event.type === "response.incomplete") {
			finalizeResponse(event.response);
		} else if (event.type === "error") {
			throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
		} else if (event.type === "response.failed") {
			sawTerminalResponseEvent = true;
			output.rawStopReason = event.response?.status;
			const error = event.response?.error;
			const details = event.response?.incomplete_details;
			const msg = error
				? `${error.code || "unknown"}: ${error.message || "no message"}`
				: details?.reason
					? `incomplete: ${details.reason}`
					: "Unknown error (no error details in response)";
			throw new Error(msg);
		}
	}
	const hasFinalizedToolCall = output.content.some((block) => block.type === "toolCall" && !("partialJson" in block));
	if (!sawTerminalResponseEvent && !hasFinalizedToolCall) {
		throw new Error("OpenAI Responses stream ended before a terminal response event");
	}
}

function mapStopReason(status: OpenAI.Responses.ResponseStatus | undefined): StopReason {
	if (!status) return "stop";
	switch (status) {
		case "completed":
			return "stop";
		case "incomplete":
			return "length";
		case "failed":
		case "cancelled":
			return "error";
		// These two are wonky ...
		case "in_progress":
		case "queued":
			return "stop";
		default: {
			const _exhaustive: never = status;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}
