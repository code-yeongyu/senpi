/**
 * The opaque replay signature each assistant content block may carry: an encrypted reasoning payload or
 * provider metadata handed back for multi-turn continuity, never context text. The visible estimate
 * (`computeEstimateTokens`) already prices them at zero.
 */
const OPAQUE_SIGNATURE_FIELD = new Map<string, string>([
	["thinking", "thinkingSignature"],
	["text", "textSignature"],
	["toolCall", "thoughtSignature"],
]);

/**
 * `JSON.stringify` replacer for the deterministic fallback's envelope estimate (senpi#4148): drops each content
 * block's opaque signature so the 4x base64 weight is not applied to it, while every other field still counts.
 */
export function withoutOpaqueSignatures(this: unknown, key: string, value: unknown): unknown {
	if (typeof value !== "string" || typeof this !== "object" || this === null || !("type" in this)) return value;
	return typeof this.type === "string" && OPAQUE_SIGNATURE_FIELD.get(this.type) === key ? undefined : value;
}
