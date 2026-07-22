import type {
	Api,
	AssistantMessage,
	ImageContent,
	Message,
	Model,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
import { isVideoMimeType } from "../types.ts";

const NON_VISION_USER_IMAGE_PLACEHOLDER = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = "(tool image omitted: model does not support images)";
const NO_VIDEO_USER_PLACEHOLDER = "(video omitted: model does not support video input)";
const NO_VIDEO_TOOL_PLACEHOLDER = "(tool video omitted: model does not support video input)";

function replaceMediaWithPlaceholder(
	content: (TextContent | ImageContent)[],
	placeholder: string,
	matches: (block: ImageContent) => boolean,
): (TextContent | ImageContent)[] {
	if (!content.some((block) => block.type === "image" && matches(block))) {
		return content;
	}
	const result: (TextContent | ImageContent)[] = [];
	let previousWasPlaceholder = false;

	for (const block of content) {
		if (block.type === "image" && matches(block)) {
			if (!previousWasPlaceholder) {
				result.push({ type: "text", text: placeholder });
			}
			previousWasPlaceholder = true;
			continue;
		}

		result.push(block);
		previousWasPlaceholder = block.type === "text" && block.text === placeholder;
	}

	return result;
}

function replaceImagesWithPlaceholder(content: (TextContent | ImageContent)[], placeholder: string): TextContent[] {
	const result: TextContent[] = [];
	let previousWasPlaceholder = false;

	for (const block of content) {
		if (block.type === "image") {
			if (!previousWasPlaceholder) {
				result.push({ type: "text", text: placeholder });
			}
			previousWasPlaceholder = true;
			continue;
		}

		result.push(block);
		previousWasPlaceholder = block.text === placeholder;
	}

	return result;
}

function downgradeUnsupportedImages<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
	const supportsImages = model.input.includes("image");
	const supportsVideo = model.input.includes("video");
	if (supportsImages && supportsVideo) {
		return messages;
	}

	return messages.map((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			let content = msg.content;
			// Video payloads ride ImageContent blocks; strip them first for models
			// without the "video" modality so they never hit an incompatible wire.
			if (!supportsVideo) {
				content = replaceMediaWithPlaceholder(content, NO_VIDEO_USER_PLACEHOLDER, (b) =>
					isVideoMimeType(b.mimeType),
				);
			}
			if (!supportsImages) {
				content = replaceImagesWithPlaceholder(content, NON_VISION_USER_IMAGE_PLACEHOLDER);
			}
			return { ...msg, content };
		}

		if (msg.role === "toolResult") {
			let content = msg.content;
			if (!supportsVideo) {
				content = replaceMediaWithPlaceholder(content, NO_VIDEO_TOOL_PLACEHOLDER, (b) =>
					isVideoMimeType(b.mimeType),
				);
			}
			if (!supportsImages) {
				content = replaceImagesWithPlaceholder(content, NON_VISION_TOOL_IMAGE_PLACEHOLDER);
			}
			return { ...msg, content };
		}

		return msg;
	});
}

export interface TransformMessagesOptions {
	/**
	 * Preserve provider-native thinking/reasoning replay state for the current
	 * model. When false, standalone same-model thinking is omitted, while
	 * thinking attached to tool calls is preserved for provider validation.
	 */
	preserveThinking?: boolean;
	preserveTextSignatures?: boolean;
	/**
	 * Preserve same-model thinking blocks that do not carry a usable signature
	 * so provider adapters can downgrade them to plain text or provider-specific
	 * compatibility payloads.
	 */
	preserveUnsignedThinking?: boolean;
}

/**
 * Normalize tool call ID for cross-provider compatibility.
 * OpenAI Responses API generates IDs that are 450+ chars with special characters like `|`.
 * Anthropic APIs require IDs matching ^[a-zA-Z0-9_-]+$ (max 64 chars).
 */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
	options: TransformMessagesOptions = {},
): Message[] {
	// Build a map of original tool call IDs to normalized IDs
	const toolCallIdMap = new Map<string, string>();
	// Normalize null/undefined content from untyped callers (custom tools, hand-built
	// histories, old session files) so downstream code can rely on the type contract.
	const normalizedMessages = messages.map((msg) => (msg.content == null ? { ...msg, content: [] } : msg));
	const imageAwareMessages = downgradeUnsupportedImages(normalizedMessages, model);
	const preserveThinking = options.preserveThinking ?? true;
	const preserveTextSignatures = options.preserveTextSignatures ?? false;
	const preserveUnsignedThinking = options.preserveUnsignedThinking ?? false;

	// First pass: transform messages (unsupported image downgrade, thinking blocks, tool call ID normalization)
	const transformed = imageAwareMessages.map((msg) => {
		// User messages pass through unchanged
		if (msg.role === "user") {
			return msg;
		}

		// Handle toolResult messages - normalize toolCallId if we have a mapping
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}

		// Assistant messages need transformation check
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const isSameModel =
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				assistantMsg.model === model.id;
			const hasToolCalls = assistantMsg.content.some((block) => block.type === "toolCall");
			const preserveProviderState = preserveThinking || hasToolCalls;

			const transformedContent = assistantMsg.content.flatMap((block) => {
				if (block.type === "thinking") {
					// Redacted thinking is opaque encrypted content, only valid for the same model.
					// Drop it for cross-model to avoid API errors.
					if (block.redacted) {
						return isSameModel && preserveProviderState ? { ...block } : [];
					}
					const hasUsableSignature =
						typeof block.thinkingSignature === "string" && block.thinkingSignature.trim().length > 0;
					// For same model: keep signed thinking only while replaying provider state.
					// Empty signed blocks are opaque compatibility state, not visible reasoning.
					if (isSameModel && hasUsableSignature && (preserveProviderState || block.thinking.trim() === "")) {
						return { ...block };
					}
					// Skip empty thinking blocks, convert others to plain text
					if (!block.thinking || block.thinking.trim() === "") return [];
					if (isSameModel) {
						return preserveProviderState || (preserveUnsignedThinking && !hasUsableSignature) ? { ...block } : [];
					}
					return {
						type: "text" as const,
						text: block.thinking,
					};
				}

				if (block.type === "text") {
					if (isSameModel && (preserveProviderState || preserveTextSignatures)) return { ...block };
					return {
						type: "text" as const,
						text: block.text,
					};
				}

				if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					let normalizedToolCall: ToolCall = { ...toolCall };

					if ((!isSameModel || !preserveProviderState) && toolCall.thoughtSignature) {
						delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
					}

					if (!isSameModel && normalizeToolCallId) {
						const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
						if (normalizedId !== toolCall.id) {
							toolCallIdMap.set(toolCall.id, normalizedId);
							normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
						}
					}

					return normalizedToolCall;
				}

				return block;
			});

			return {
				...assistantMsg,
				content: transformedContent,
			};
		}
		return msg;
	});

	// Second pass: pair every replayable tool call with the earliest unconsumed
	// result after its declaring assistant. Results are emitted adjacent to their
	// calls because Anthropic requires that ordering. A reused ID starts a new
	// pairing window, so a later result cannot repair an earlier call.
	const result: Message[] = [];
	const toolResultsById = new Map<string, { message: ToolResultMessage; sourceIndex: number; consumed: boolean }[]>();
	const nextToolCallIndexById = new Map<string, number[]>();
	// Tool calls declared only by assistants the emit loop drops (errored/aborted).
	// Their results must not be emitted either: a strict provider rejects a tool
	// message whose tool_call_id no assistant in the request declares.
	const droppedCallIds = new Set<string>();

	for (let sourceIndex = 0; sourceIndex < transformed.length; sourceIndex++) {
		const message = transformed[sourceIndex];
		if (message.role === "toolResult") {
			const entries = toolResultsById.get(message.toolCallId) ?? [];
			entries.push({ message, sourceIndex, consumed: false });
			toolResultsById.set(message.toolCallId, entries);
			continue;
		}
		if (message.role !== "assistant") {
			continue;
		}
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			for (const block of message.content) {
				if (block.type === "toolCall") droppedCallIds.add(block.id);
			}
			continue;
		}
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const indexes = nextToolCallIndexById.get(block.id) ?? [];
			indexes.push(sourceIndex);
			nextToolCallIndexById.set(block.id, indexes);
		}
	}

	for (let sourceIndex = 0; sourceIndex < transformed.length; sourceIndex++) {
		const message = transformed[sourceIndex];
		if (message.role === "toolResult") {
			const entry = toolResultsById
				.get(message.toolCallId)
				?.find((candidate) => candidate.sourceIndex === sourceIndex);
			if (!entry?.consumed) {
				// Skip results whose call was declared only by a dropped
				// (errored/aborted) assistant. An id re-declared by a kept assistant
				// still pairs through the normal windows, so keep those results.
				if (!droppedCallIds.has(message.toolCallId) || nextToolCallIndexById.has(message.toolCallId)) {
					result.push(message);
				}
			}
			continue;
		}
		if (message.role !== "assistant") {
			result.push(message);
			continue;
		}

		// Skip errored/aborted assistant messages entirely. These incomplete turns
		// must not be revived merely because a matching result appears later.
		if (message.stopReason === "error" || message.stopReason === "aborted") continue;

		result.push(message);
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			const laterDeclarations = nextToolCallIndexById.get(block.id) ?? [];
			const nextDeclarationIndex = laterDeclarations.find((index) => index > sourceIndex) ?? Infinity;
			const matchedResult = toolResultsById
				.get(block.id)
				?.find(
					(candidate) =>
						!candidate.consumed &&
						candidate.sourceIndex > sourceIndex &&
						candidate.sourceIndex < nextDeclarationIndex,
				);

			if (matchedResult) {
				matchedResult.consumed = true;
				result.push(matchedResult.message);
				continue;
			}

			result.push({
				role: "toolResult",
				toolCallId: block.id,
				toolName: block.name,
				content: [{ type: "text", text: "No result provided" }],
				isError: true,
				timestamp: Date.now(),
			} as ToolResultMessage);
		}
	}

	return result;
}
