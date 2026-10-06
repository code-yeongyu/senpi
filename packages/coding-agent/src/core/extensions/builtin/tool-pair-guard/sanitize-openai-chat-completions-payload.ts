function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function hasMessagesArray(value: unknown): value is { messages: unknown[] } {
	return isObject(value) && Array.isArray(value.messages);
}

const SYNTHETIC_OUTPUT = "Tool output unavailable (interrupted before result)";

type ChatCompletionMessage = Record<string, unknown>;
type ChatCompletionToolCall = Record<string, unknown> & { id: string };

function isToolCall(value: unknown): value is ChatCompletionToolCall {
	return isObject(value) && typeof value.id === "string" && value.id.length > 0;
}

function getToolCalls(value: unknown): ChatCompletionToolCall[] | undefined {
	if (!isObject(value) || value.role !== "assistant") return undefined;
	const calls = value.tool_calls ?? value.toolCalls;
	if (!Array.isArray(calls)) return undefined;
	for (const call of calls) {
		if (!isToolCall(call)) return undefined;
	}
	return calls;
}

function isToolRoleMessage(value: unknown): value is ChatCompletionMessage {
	return isObject(value) && value.role === "tool";
}

function getToolCallId(value: ChatCompletionMessage): string | undefined {
	const id = value.tool_call_id ?? value.toolCallId;
	return typeof id === "string" ? id : undefined;
}

function createSyntheticToolMessage(toolCallId: string, nativeFields: boolean): ChatCompletionMessage {
	return {
		role: "tool",
		...(nativeFields ? { toolCallId } : { tool_call_id: toolCallId }),
		content: SYNTHETIC_OUTPUT,
	};
}

function flushMissingToolResults(
	pendingToolCallIds: string[],
	sanitizedMessages: unknown[],
	nativeFields: boolean,
): boolean {
	if (pendingToolCallIds.length === 0) return false;
	for (const toolCallId of pendingToolCallIds) {
		sanitizedMessages.push(createSyntheticToolMessage(toolCallId, nativeFields));
	}
	pendingToolCallIds.length = 0;
	return true;
}

/** Repairs OpenAI-compatible request messages, including Mistral's pre-wire tool fields. */
export function sanitizeOpenAIChatCompletionsPayload(payload: unknown): unknown {
	if (!hasMessagesArray(payload)) return payload;

	let changed = false;
	let pendingNativeFields = false;
	const sanitizedMessages: unknown[] = [];
	const pendingToolCallIds: string[] = [];
	const pendingToolCallIdSet = new Set<string>();

	for (const message of payload.messages) {
		const toolCalls = getToolCalls(message);
		if (toolCalls !== undefined) {
			if (flushMissingToolResults(pendingToolCallIds, sanitizedMessages, pendingNativeFields)) {
				pendingToolCallIdSet.clear();
				changed = true;
			}

			sanitizedMessages.push(message);
			pendingNativeFields = isObject(message) && !Array.isArray(message.tool_calls);
			for (const call of toolCalls) {
				pendingToolCallIds.push(call.id);
				pendingToolCallIdSet.add(call.id);
			}
			continue;
		}

		if (isToolRoleMessage(message)) {
			const toolCallId = getToolCallId(message);
			if (!toolCallId || !pendingToolCallIdSet.has(toolCallId)) {
				changed = true;
				continue;
			}

			sanitizedMessages.push(message);
			pendingToolCallIdSet.delete(toolCallId);
			const pendingIndex = pendingToolCallIds.indexOf(toolCallId);
			if (pendingIndex >= 0) pendingToolCallIds.splice(pendingIndex, 1);
			continue;
		}

		if (flushMissingToolResults(pendingToolCallIds, sanitizedMessages, pendingNativeFields)) {
			pendingToolCallIdSet.clear();
			changed = true;
		}
		sanitizedMessages.push(message);
	}

	if (flushMissingToolResults(pendingToolCallIds, sanitizedMessages, pendingNativeFields)) changed = true;

	if (!changed) return payload;
	return { ...payload, messages: sanitizedMessages };
}
