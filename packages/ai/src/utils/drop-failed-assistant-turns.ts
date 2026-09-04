import type { AssistantMessage, Message } from "../types.ts";

/**
 * Drop assistant turns that terminated in failure (`stopReason` "error" or
 * "aborted") from a converted LLM message list, together with every tool
 * result whose `toolCallId` was declared ONLY by those dropped assistants.
 * An id re-declared by any kept assistant keeps its results, mirroring the
 * `droppedCallIds` pairing in `api/transform-messages.ts`. Order and every
 * other message are preserved.
 *
 * A failed turn is the provider's response to the previous request, never part
 * of one, so removing it keeps every earlier request a prefix of the next
 * (provider prompt caches survive) while preventing the replay of partial text
 * and unexecuted tool calls on lanes that build requests straight from
 * `convertToLlm` output (claude-sdk-oauth prompt bridge, cursor turns, token
 * estimation).
 */
export function dropFailedAssistantTurns(messages: readonly Message[]): Message[] {
	const callIdsByKeptAssistants = new Set<string>();
	const callIdsByFailedAssistants = new Set<string>();
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const declared = isFailedAssistant(message) ? callIdsByFailedAssistants : callIdsByKeptAssistants;
		for (const block of message.content) {
			if (block.type === "toolCall") declared.add(block.id);
		}
	}
	for (const id of callIdsByKeptAssistants) callIdsByFailedAssistants.delete(id);

	return messages.filter((message) => {
		if (message.role === "assistant") return !isFailedAssistant(message);
		if (message.role === "toolResult") return !callIdsByFailedAssistants.has(message.toolCallId);
		return true;
	});
}

function isFailedAssistant(message: AssistantMessage): boolean {
	return message.stopReason === "error" || message.stopReason === "aborted";
}
