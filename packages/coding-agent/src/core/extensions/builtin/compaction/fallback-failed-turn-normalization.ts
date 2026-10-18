import { dropFailedAssistantTurns } from "@earendil-works/pi-ai";

/**
 * Mark the messages that the transport's canonical failed-turn normalization
 * removes before a provider request.
 *
 * `convertToLlm` (`core/messages.ts`) ends with `dropFailedAssistantTurns`, so an
 * assistant turn that stopped with `error` or `aborted` - together with every tool
 * result orphaned by that drop - never reaches the provider. The deterministic
 * compaction fallback evaluates the same projection, so those fragments must not be
 * counted as incomplete tool calls or charged against the retained budget.
 *
 * The shared function is reused directly (no rule mirroring) and the input array is
 * never mutated: the result is a positional mask over the caller's own messages.
 * Index `i` is `true` when message `i` is dropped by that normalization.
 */
export function markFailedTurnFragments<T extends { role: string }>(messages: readonly T[]): boolean[] {
	const retained = new Set<T>(dropFailedAssistantTurns(messages));
	return messages.map((message) => !retained.has(message));
}
