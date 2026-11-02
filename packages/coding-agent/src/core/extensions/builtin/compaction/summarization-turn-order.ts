import type { Message } from "@earendil-works/pi-ai";

/**
 * Normalizes a summarization request's final message list so strict
 * turn-alternation providers (Gemini) accept it. Gemini rejects a functionCall
 * model turn that follows another model turn, and rejects any conversation
 * whose first turn is not a user turn — both shapes occur in real
 * summarization inputs:
 *
 * - sessions contain adjacent assistant messages (split turns, retries), and
 * - budget pruning / overflow shrinking can drop the leading user message.
 *
 * This runs on the converted LLM message list (after convertToLlm, where
 * context-excluded entries are already dropped and roles are final), and the
 * caller re-runs pair repair on the result so the leading drop cannot leave an
 * orphaned toolResult behind. Two repairs, in order:
 *
 * 1. Adjacent assistant messages are merged into one (content concatenated).
 *    Messages with stopReason error/aborted are left alone: downstream
 *    provider transforms drop them, which heals the ordering on its own, and
 *    merging would replay partial content those transforms intentionally
 *    discard. The merged message keeps the first message's metadata
 *    (stopReason, usage): these messages are outbound request payloads only,
 *    where usage is never read and stopReason is consumed solely as the
 *    error/aborted drop filter this merge already excludes.
 * 2. Everything before the first user message is dropped. Budget pruning has
 *    already judged the oldest content expendable; a leading assistant /
 *    toolResult fragment would only produce a provider rejection. The list
 *    passes through unchanged when no user message exists, and when the only
 *    user message is the trailing summarization instruction itself — dropping
 *    there would summarize nothing, so both paths are defensive only.
 */
export function normalizeSummarizationTurnOrder(messages: Message[]): Message[] {
	const merged: Message[] = [];
	for (const message of messages) {
		const previous = merged[merged.length - 1];
		if (previous?.role === "assistant" && message.role === "assistant") {
			const mergedPair = mergeAssistantPair(previous, message);
			if (mergedPair !== undefined) {
				merged[merged.length - 1] = mergedPair;
				continue;
			}
		}
		merged.push(message);
	}
	const firstUserIndex = merged.findIndex((message) => message.role === "user");
	if (firstUserIndex === -1) return merged;
	// When the only user turn is the trailing summarization instruction, the
	// drop would leave a summary of nothing; keeping the content preserves the
	// pre-normalization behavior for that narrow case on every provider.
	if (firstUserIndex === merged.length - 1) return merged;
	return merged.slice(firstUserIndex);
}

function mergeAssistantPair(first: Message, second: Message): Message | undefined {
	if (first.role !== "assistant" || second.role !== "assistant") return undefined;
	if (first.stopReason === "error" || first.stopReason === "aborted") return undefined;
	if (second.stopReason === "error" || second.stopReason === "aborted") return undefined;
	// AssistantMessage.content is an array by type; the runtime check guards
	// against corrupted persisted session data, which arrives unvalidated.
	if (!Array.isArray(first.content) || !Array.isArray(second.content)) return undefined;
	return { ...first, content: [...first.content, ...second.content] };
}
