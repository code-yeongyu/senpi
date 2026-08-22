import type { Tool } from "@earendil-works/pi-ai";

/**
 * Summarization is a prose-only LLM call. Forwarding the live agent tool list
 * lets tool-preferring models (observed: openai-codex/gpt-5.6-sol) end the
 * summary with `stopReason: toolUse` and no text, which senpi rejects as
 * `empty-summary` and leaves the session above the compaction threshold.
 */
export function compactionSummarizationTools(_liveTools?: Tool[]): Tool[] {
	return [];
}
