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
import { calculateCost, supportsConfigurationUpdate } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	ProviderNativeContent,
	StopReason,
	StreamOptions,
	SystemMessage,
	TextContent,
	TextSignatureV1,
	ThinkingContent,
	Tool,
	ToolCall,
	TranscriptContext,
	Usage,
} from "../types.ts";
import { splitDeferredTools } from "../utils/deferred-tools.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { getSystemMessageText, renderSystemMessageUpdate } from "../utils/text.ts";
import { getCurrentTools, getDeclaredTools, resolveTranscript, resolveTranscriptTools } from "../utils/transcript.ts";
import {
	appendGrammarToolInputJsonDelta,
	type GrammarToolInputJsonBuffer,
	getGrammarToolInput,
	getJsonSchemaToolParameters,
	resolveGrammarConstrainedSampling,
	resolveJsonSchemaStrictSampling,
} from "./constrained-sampling.ts";
import { parsePromptCacheDiagnostics } from "./openai-responses-prompt-cache.ts";
import { withResponsesCompletionGrace } from "./responses-completion-grace.ts";
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
	onProviderStreamEvent?: StreamOptions["onProviderStreamEvent"];
	serviceTier?: ResponseCreateParamsStreaming["service_tier"] | "fast" | "ultrafast";
	grammarToolInputProperties?: ReadonlyMap<string, string>;
	resolveServiceTier?: (
		responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | "fast" | "ultrafast" | undefined,
		requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | "fast" | "ultrafast" | undefined,
	) => ResponseCreateParamsStreaming["service_tier"] | "fast" | "ultrafast" | undefined;
	applyServiceTierPricing?: (
		usage: Usage,
		serviceTier: ResponseCreateParamsStreaming["service_tier"] | "fast" | "ultrafast" | undefined,
	) => void;
}

export interface ConvertResponsesMessagesOptions {
	includeSystemPrompt?: boolean;
	preserveThinking?: boolean;
	preserveTextSignatures?: boolean;
	grammarToolInputProperties?: ReadonlyMap<string, string>;
	/** Whether later system messages are sent in place; otherwise they are folded into the leading prompt. */
	supportsMidConvoSystemMessages?: boolean;
	supportsAdditionalTools?: boolean;
	supportsToolSearch?: boolean;
	toolOptions?: ConvertResponsesToolsOptions;
	/**
	 * Send the system prompt as one `input_text` block carrying an explicit
	 * `prompt_cache_breakpoint`, so the platform writes and looks up the prefix at the end of
	 * the system prompt even when hosted tools (`web_search_preview`) are present (senpi#2096).
	 */
	systemPromptCacheBreakpoint?: boolean;
	/** Internal request-local provenance sealing pass. Never serialized to provider payloads. */
	sealContextProvenance?: boolean;
}

export interface ConvertResponsesToolsOptions {
	strict?: boolean | null;
	supportsStrictMode?: boolean;
	supportsOpenAIGrammarTools?: boolean;
	toolSearchResult?: boolean;
}

type ResponseCustomToolCallItem = {
	type: "custom_tool_call";
	id?: string;
	call_id: string;
	name: string;
	input?: string;
	namespace?: string;
};

type ResponseCustomToolCallOutputItem = {
	type: "custom_tool_call_output";
	call_id: string;
	name?: string;
	output: string | ResponseFunctionCallOutputItemList;
};

type AdditionalToolsInputItem = {
	type: "additional_tools";
	role: "developer";
	tools: OpenAITool[];
};

type ResponseInputItem =
	| OpenAIResponseInputItem
	| ResponseCustomToolCallItem
	| ResponseCustomToolCallOutputItem
	| AdditionalToolsInputItem
	| { type: "configuration_update"; reasoning: { effort: string } };

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
// Tool placement
// =============================================================================

export type ResponsesDeferredToolsMode = "additional-tools" | "tool-search";

/** `additional_tools` items win over client tool search when a model supports both. */
export function resolveResponsesDeferredToolsMode(
	compat: { supportsAdditionalTools?: boolean; supportsToolSearch?: boolean } | undefined,
): ResponsesDeferredToolsMode | undefined {
	if (compat?.supportsAdditionalTools) return "additional-tools";
	return compat?.supportsToolSearch ? "tool-search" : undefined;
}

export interface ResponsesToolPlacement {
	/** Tools sent in the top-level `tools` field. */
	requestTools: Tool[];
	/** Whether later system messages load their own `toolsAdded` in place. */
	anchorsAdditions: boolean;
	/** Tools a tool result loads in place through `addedToolNames`. */
	deferred: ReadonlyMap<string, Tool>;
}

/**
 * Upstream transcript placement plus the fork's `addedToolNames` deferral: a current tool first named by a
 * tool result's `addedToolNames` (before any call to it) leaves the top-level `tools` field and is loaded
 * where that result appears, so lazy activation never rewrites the cached prefix.
 */
export function resolveResponsesToolPlacement(
	messages: readonly Message[],
	supportsToolAdditions: boolean,
): ResponsesToolPlacement {
	const transcriptTools = resolveTranscriptTools(messages, supportsToolAdditions);
	const { deferred } = splitDeferredTools(
		{ messages: [...messages], tools: getCurrentTools(messages) },
		supportsToolAdditions,
	);
	return {
		requestTools: transcriptTools.requestTools.filter((tool) => !deferred.has(tool.name)),
		anchorsAdditions: transcriptTools.anchorsAdditions,
		deferred,
	};
}

// =============================================================================
// Message conversion
// =============================================================================

export function convertResponsesMessages<TApi extends Api>(
	model: Model<TApi>,
	context: TranscriptContext,
	allowedToolCallProviders: ReadonlySet<string>,
	options?: ConvertResponsesMessagesOptions,
): ResponseInput {
	const normalizedContext = resolveTranscript(context, options?.supportsMidConvoSystemMessages);
	const messages: ResponseInputItem[] = [];
	const deferredToolsMode = resolveResponsesDeferredToolsMode(options);
	const toolPlacement = resolveResponsesToolPlacement(normalizedContext.messages, deferredToolsMode !== undefined);
	const declaredTools = getDeclaredTools(normalizedContext.messages);
	// One ledger for both in-place loading paths: transcript system messages and `addedToolNames`.
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

	const transformedMessages = transformMessages(normalizedContext.messages, model, normalizeToolCallId, {
		preserveThinking: options?.preserveThinking,
		preserveTextSignatures: options?.preserveTextSignatures,
	});
	const appendSystemToolAdditions = (message: SystemMessage, seed: string): void => {
		const tools = toolPlacement.anchorsAdditions
			? (message.toolsAdded ?? []).filter((tool) => !loadedToolNames.has(tool.name))
			: [];
		if (tools.length === 0) return;
		for (const tool of tools) loadedToolNames.add(tool.name);
		if (options?.supportsAdditionalTools) {
			messages.push({
				type: "additional_tools",
				role: "developer",
				tools: convertResponsesTools(tools, options.toolOptions),
			} satisfies ResponseInputItem);
			return;
		}
		if (!options?.supportsToolSearch) return;
		const names = tools.map((tool) => tool.name);
		const callId = `pi_tool_load_${shortHash(`${seed}:${names.join(",")}`)}`;
		messages.push({
			type: "tool_search_call",
			call_id: callId,
			execution: "client",
			status: "completed",
			arguments: { query: names.join(" "), limit: names.length },
		} satisfies ResponseInputItem);
		messages.push({
			type: "tool_search_output",
			call_id: callId,
			execution: "client",
			status: "completed",
			tools: convertResponsesTools(tools, { ...options.toolOptions, toolSearchResult: true }),
		} satisfies ResponseToolSearchOutputItemParam);
	};
	const includeInitialSystemMessage = options?.includeSystemPrompt ?? true;
	const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined;
	const instructionRole = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";

	let msgIndex = 0;
	let sourceIndex = 0;
	for (const msg of transformedMessages) {
		const isLeadingSystemMessage = sourceIndex++ === 0 && msg.role === "system";
		if (msg.role === "configurationUpdate") {
			if (!supportsConfigurationUpdate(model)) continue;
			const previous = messages[messages.length - 1];
			if (previous?.type === "configuration_update") {
				messages[messages.length - 1] = {
					type: "configuration_update",
					reasoning: { effort: msg.effort },
				};
			} else {
				messages.push({ type: "configuration_update", reasoning: { effort: msg.effort } });
			}
			continue;
		}
		if (msg.role === "system") {
			if (!isLeadingSystemMessage) appendSystemToolAdditions(msg, `system:${msgIndex}`);
			if (!isLeadingSystemMessage || includeInitialSystemMessage) {
				const text = isLeadingSystemMessage ? getSystemMessageText(msg) : renderSystemMessageUpdate(msg);
				if (text.length > 0 && isLeadingSystemMessage && options?.systemPromptCacheBreakpoint === true) {
					const block = {
						type: "input_text" as const,
						text: sanitizeSurrogates(text),
						prompt_cache_breakpoint: { mode: "explicit" },
					};
					messages.push({ role: instructionRole, content: [block] });
				} else if (text.length > 0) {
					messages.push({ role: instructionRole, content: sanitizeSurrogates(text) });
				}
			}
		} else if (msg.role === "user") {
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
			const isSameProviderAndApi = assistantMsg.provider === model.provider && assistantMsg.api === model.api;
			const isSameModel = isSameProviderAndApi && assistantMsg.model === model.id;
			const isDifferentModel = isSameProviderAndApi && assistantMsg.model !== model.id;
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
					const isFreeform = isFreeformToolName(toolCall.name, declaredTools) || isPersistedFreeform;
					let itemId: string | undefined = isPersistedFreeform ? undefined : itemIdRaw;

					// An active grammar declaration wins over sentinel recovery below: its
					// named input property is richer than the persisted freeform fallback.

					// For different-model messages, set id to undefined to avoid pairing validation.
					// OpenAI tracks which item IDs were paired with rs_xxx reasoning items.
					// By omitting the id, we avoid triggering that validation (like cross-provider does).
					// Also drop ids that do not match the replayed item type: function_call ids must be fc_*
					// and custom_tool_call ids must be ctc_*. Foreign tool call ids are normalized to fc_*, and
					// a call can switch between the two types when grammar tool support differs. Freeform
					// calls replay without an item id and without the local <call_id>|custom sentinel.
					const itemIdPrefix = customInputProperty === undefined ? "fc_" : "ctc_";
					if (isDifferentModel || !itemId?.startsWith(itemIdPrefix)) {
						itemId = undefined;
					}

					const canReplayNamespace = isSameModel || toolPlacement.deferred.has(toolCall.name);

					if (customInputProperty !== undefined) {
						output.push({
							type: "custom_tool_call",
							...(itemId !== undefined ? { id: itemId } : {}),
							call_id: callId,
							name: toolCall.name,
							input: sanitizeSurrogates(
								getGrammarToolInput(toolCall.name, toolCall.arguments, customInputProperty),
							),
							...(canReplayNamespace && toolCall.namespace !== undefined
								? { namespace: toolCall.namespace }
								: {}),
						} satisfies ResponseCustomToolCallItem);
					} else if (isFreeform) {
						output.push({
							type: "custom_tool_call",
							call_id: callId,
							name: toolCall.name,
							input: getFreeformToolInput(toolCall.arguments),
							...(canReplayNamespace && toolCall.namespace !== undefined
								? { namespace: toolCall.namespace }
								: {}),
						} satisfies ResponseCustomToolCallItem);
					} else {
						output.push({
							type: "function_call",
							...(itemId?.startsWith("fc_") ? { id: itemId } : {}),
							call_id: callId,
							name: toolCall.name,
							arguments: JSON.stringify(toolCall.arguments),
							...(canReplayNamespace && toolCall.namespace !== undefined
								? { namespace: toolCall.namespace }
								: {}),
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
			} else if (isFreeformToolName(msg.toolName, declaredTools) || isPersistedFreeform) {
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
				const tool = toolPlacement.deferred.get(name);
				if (!tool || loadedToolNames.has(name)) continue;
				loadedToolNames.add(name);
				deferredTools.push(tool);
			}
			if (deferredTools.length > 0 && deferredToolsMode === "additional-tools") {
				messages.push(
					withContextProvenance(
						{
							type: "additional_tools",
							role: "developer",
							tools: convertResponsesTools(deferredTools, options?.toolOptions),
						} satisfies ResponseInputItem,
						msg,
						options?.sealContextProvenance,
					),
				);
			} else if (deferredTools.length > 0 && deferredToolsMode === "tool-search") {
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
								toolSearchResult: true,
							}),
						} satisfies ResponseToolSearchOutputItemParam,
						msg,
						options?.sealContextProvenance,
					),
				);
			}
		}
		if (!isLeadingSystemMessage) msgIndex++;
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
				...(options?.toolSearchResult ? { defer_loading: true } : {}),
			} satisfies OpenAITool;
		}
		if (tool.freeform) {
			return {
				type: "custom",
				name: tool.name,
				description: tool.description,
				format: tool.freeform,
				...(options?.toolSearchResult ? { defer_loading: true } : {}),
			} as OpenAITool;
		}

		const constrainedStrict = resolveJsonSchemaStrictSampling(tool, supportsStrictMode);
		const strict = constrainedStrict ?? defaultStrict;
		const functionTool: Omit<ResponseFunctionTool, "strict"> & {
			strict?: ResponseFunctionTool["strict"];
		} = {
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: getJsonSchemaToolParameters(tool, strict === true) as ResponseFunctionTool["parameters"],
			...(options?.toolSearchResult ? { defer_loading: true } : {}),
		};
		if (supportsStrictMode) {
			functionTool.strict = strict;
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

type NativeImageGenerationCall = {
	type: "image_generation_call";
	id?: string;
	status: string;
	result?: string | null;
	revised_prompt?: string;
};

const MAX_NATIVE_IMAGE_BASE64_CHARS = 24 * 1024 * 1024;

function readNativeImageGenerationCall(value: unknown): NativeImageGenerationCall | undefined {
	if (typeof value !== "object" || value === null || !("type" in value) || !("status" in value)) return undefined;
	if (value.type !== "image_generation_call" || typeof value.status !== "string") return undefined;
	return {
		type: "image_generation_call",
		...("id" in value && typeof value.id === "string" ? { id: value.id } : {}),
		status: value.status,
		...("result" in value && (typeof value.result === "string" || value.result === null)
			? { result: value.result }
			: {}),
		...("revised_prompt" in value && typeof value.revised_prompt === "string"
			? { revised_prompt: value.revised_prompt }
			: {}),
	};
}

function isValidBase64(value: string): boolean {
	return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

function reconcileNativeImageGenerationCall(item: NativeImageGenerationCall): NativeImageGenerationCall {
	if (item.status !== "completed") {
		return {
			type: "image_generation_call",
			...(item.id !== undefined ? { id: item.id } : {}),
			status: item.status,
		};
	}
	if (typeof item.result !== "string" || !isValidBase64(item.result)) {
		return {
			type: "image_generation_call",
			...(item.id !== undefined ? { id: item.id } : {}),
			status: "malformed",
		};
	}
	return {
		type: "image_generation_call",
		...(item.id !== undefined ? { id: item.id } : {}),
		status: "completed",
		result: item.result,
		...(item.revised_prompt?.trim() ? { revised_prompt: item.revised_prompt } : {}),
	};
}

export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options?: OpenAIResponsesStreamOptions,
): Promise<void> {
	let sawTerminalResponseEvent = false;
	let nativeImageBase64Chars = 0;
	const outputSlots = new Map<number, ResponsesOutputSlot>();
	const reasoningBlocksById = new Map<string, ThinkingContent>();
	const nativeImageCharsByOutputIndex = new Map<number, number>();
	const finalizedNativeImageOutputIndexes = new Set<number>();
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
				...(item.namespace !== undefined ? { namespace: item.namespace } : {}),
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
				...(item.namespace !== undefined ? { namespace: item.namespace } : {}),
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
		const imageItem = readNativeImageGenerationCall(item);
		const block = {
			type: "providerNative",
			subtype: item.type,
			raw: imageItem ? reconcileNativeImageGenerationCall(imageItem) : item,
		} satisfies ProviderNativeContent;
		const slot = {
			type: "providerNative",
			block,
			contentIndex: output.content.length,
		} satisfies ResponsesOutputSlot;
		if (imageItem) reconcileNativeImageSlot(outputIndex, slot, imageItem);
		output.content.push(block);
		outputSlots.set(outputIndex, slot);
		return slot;
	};
	const getOrCreateSlot = (
		outputIndex: number,
		item: ResponseOutputItem | ResponseCustomToolCallItem,
	): ResponsesOutputSlot | undefined => {
		return outputSlots.get(outputIndex) ?? createSlot(outputIndex, item);
	};
	function scrubNativeImageResults(): void {
		for (const block of output.content) {
			if (block.type !== "providerNative" || block.subtype !== "image_generation_call") continue;
			const item = readNativeImageGenerationCall(block.raw);
			if (typeof item?.result !== "string") continue;
			block.raw = {
				type: "image_generation_call",
				...(item.id !== undefined ? { id: item.id } : {}),
				status: "malformed",
			};
		}
		nativeImageBase64Chars = 0;
		nativeImageCharsByOutputIndex.clear();
	}
	function reconcileNativeImageSlot(
		outputIndex: number,
		slot: Extract<ResponsesOutputSlot, { type: "providerNative" }>,
		item: NativeImageGenerationCall,
	): void {
		const reconciled = reconcileNativeImageGenerationCall(item);
		const previousChars = nativeImageCharsByOutputIndex.get(outputIndex) ?? 0;
		const nextChars = typeof reconciled.result === "string" ? reconciled.result.length : 0;
		const nextTotal = nativeImageBase64Chars - previousChars + nextChars;
		if (nextTotal > MAX_NATIVE_IMAGE_BASE64_CHARS) {
			scrubNativeImageResults();
			throw new Error("Native image generation results exceed the 24 MiB base64 limit");
		}
		nativeImageBase64Chars = nextTotal;
		if (nextChars > 0) nativeImageCharsByOutputIndex.set(outputIndex, nextChars);
		else nativeImageCharsByOutputIndex.delete(outputIndex);
		slot.block.subtype = "image_generation_call";
		slot.block.raw = reconciled;
	}
	const backfillNativeImageGenerationCalls = (responseOutput: readonly ResponseOutputItem[]): void => {
		for (const [outputIndex, outputItem] of responseOutput.entries()) {
			if (finalizedNativeImageOutputIndexes.has(outputIndex)) continue;
			const imageItem = readNativeImageGenerationCall(outputItem);
			if (!imageItem) continue;
			const existingSlot = getSlot(outputIndex, "providerNative");
			if (existingSlot) reconcileNativeImageSlot(outputIndex, existingSlot, imageItem);
			else createSlot(outputIndex, outputItem);
			outputSlots.delete(outputIndex);
		}
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
		backfillNativeImageGenerationCalls(response.output ?? []);
		if (response?.id) {
			output.responseId = response.id;
		}
		const promptCacheDiagnostics = parsePromptCacheDiagnostics(
			(response as { prompt_cache_diagnostics?: unknown } | undefined)?.prompt_cache_diagnostics,
		);
		if (promptCacheDiagnostics) output.promptCacheDiagnostics = promptCacheDiagnostics;
		if (response?.usage) {
			const inputDetails = response.usage.input_tokens_details as
				| { cached_tokens?: number; cache_write_tokens?: number; cache_creation_tokens?: number }
				| undefined;
			const cachedTokens = inputDetails?.cached_tokens || 0;
			// OpenAI platform reports cache_write_tokens; some compatible gateways use cache_creation_tokens.
			const cacheWriteTokens = inputDetails?.cache_write_tokens ?? inputDetails?.cache_creation_tokens ?? 0;
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
		// Map status to stop reason. For incomplete responses, retain the provider's
		// specific reason so max-output truncation and content filtering stay distinct.
		const status = response?.status;
		const incompleteDetails = response?.incomplete_details as { reason?: unknown } | null | undefined;
		const incompleteReason = typeof incompleteDetails?.reason === "string" ? incompleteDetails.reason : undefined;
		output.rawStopReason = incompleteReason ? `${status}.${incompleteReason}` : status;
		const mappedStop = mapStopReason(status, incompleteReason);
		output.stopReason = mappedStop.stopReason;
		if (mappedStop.errorMessage === undefined) delete output.errorMessage;
		else output.errorMessage = mappedStop.errorMessage;
		if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
			output.stopReason = "toolUse";
		}
	};

	for await (const event of withResponsesCompletionGrace(openaiStream)) {
		await options?.onProviderStreamEvent?.(event, model);
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
			const imageItem = readNativeImageGenerationCall(item);

			if (imageItem && slot?.type === "providerNative") {
				reconcileNativeImageSlot(event.output_index, slot, imageItem);
				finalizedNativeImageOutputIndexes.add(event.output_index);
				outputSlots.delete(event.output_index);
			} else if (item.type === "reasoning" && slot?.type === "thinking") {
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
				if (item.namespace !== undefined) slot.block.namespace = item.namespace;
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
				if (item.namespace !== undefined) slot.block.namespace = item.namespace;
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
			const errorEvent = event as typeof event & {
				error?: { code?: string | null; message?: string };
				status?: number;
			};
			const code = errorEvent.error?.code ?? errorEvent.code ?? errorEvent.status;
			const message = errorEvent.error?.message || errorEvent.message || "Unknown error";
			throw new Error(code == null ? message : `Error Code ${code}: ${message}`);
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
	// The agent runs every tool call in the final message. Refuse to hand over calls whose
	// output_item.done never arrived: their arguments may be cut off or mixed up, e.g. when a
	// non-compliant server omits output_index. Finished calls have their scratch buffers removed.
	if (output.stopReason === "toolUse") {
		for (const block of output.content) {
			if (block.type !== "toolCall") continue;
			const toolCall = block as StreamingToolCall;
			if (toolCall.partialJson !== undefined || toolCall.customInput !== undefined) {
				throw new Error(
					`OpenAI Responses stream completed with an unfinished tool call: ${toolCall.name} (${toolCall.id})`,
				);
			}
		}
	}
}

function mapStopReason(
	status: OpenAI.Responses.ResponseStatus | undefined,
	incompleteReason?: string,
): { stopReason: StopReason; errorMessage?: string } {
	if (!status) return { stopReason: "stop" };
	switch (status) {
		case "completed":
			return { stopReason: "stop" };
		case "incomplete":
			if (incompleteReason === "max_output_tokens") {
				return { stopReason: "length" };
			}
			return {
				stopReason: "error",
				errorMessage: incompleteReason
					? `Response incomplete: ${incompleteReason}`
					: "Response incomplete without a provider reason",
			};
		case "failed":
		case "cancelled":
			return { stopReason: "error" };
		// These two are wonky ...
		case "in_progress":
		case "queued":
			return { stopReason: "stop" };
		default: {
			const _exhaustive: never = status;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}
