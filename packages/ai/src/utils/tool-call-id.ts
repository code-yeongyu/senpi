import { shortHash } from "./hash.ts";

export const TOOL_CALL_ID_MAX_LENGTH = 64;

/**
 * Normalize tool call IDs to match the pattern and length Anthropic-family APIs
 * require (max 64 chars, alphanumeric/underscore/dash). Long foreign ids (OpenAI
 * Responses ids run 450+ chars) must not collide after truncation, so over-long
 * ids keep a readable prefix plus a hash of the full id.
 */
export function normalizeToolCallId(id: string): string {
	const sanitized = id.replace(/[^a-zA-Z0-9_-]/g, "_");
	if (sanitized.length <= TOOL_CALL_ID_MAX_LENGTH) return sanitized;
	const suffix = `_${shortHash(id)}`;
	return `${sanitized.slice(0, TOOL_CALL_ID_MAX_LENGTH - suffix.length)}${suffix}`;
}
