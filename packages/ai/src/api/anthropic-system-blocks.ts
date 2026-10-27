import type {
	BetaCacheControlEphemeral,
	BetaTextBlockParam as TextBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";

const HAS_VISIBLE_TEXT = /\S/;

/**
 * The system prompt as Anthropic `system` text blocks (senpi#4447).
 *
 * With a stable prefix, the prompt goes out as two blocks whose concatenation is the prompt: the
 * part that is the same across sessions carries the system cache breakpoint, the part that changes
 * between sessions (memory, MCP instructions) carries none. Another session then reads tools and the
 * stable part from cache even when its tail differs, and the request keeps the same number of
 * breakpoints. The later conversation breakpoint still caches the tail within a session.
 */
export function anthropicSystemTextBlocks(
	text: string,
	stablePrefix: string | undefined,
	cacheControl: BetaCacheControlEphemeral | undefined,
): TextBlockParam[] {
	const marker = cacheControl ? { cache_control: cacheControl } : {};
	const boundary = splitPoint(text, stablePrefix);
	if (boundary === undefined) return [{ type: "text", text: sanitizeSurrogates(text), ...marker }];
	return [
		{ type: "text", text: sanitizeSurrogates(text.slice(0, boundary)), ...marker },
		{ type: "text", text: sanitizeSurrogates(text.slice(boundary)) },
	];
}

/**
 * The split offset, kept off a surrogate pair. Undefined when the text no longer starts with the prefix
 * (a later rewrite of the prompt) or when either side would have no visible text.
 */
function splitPoint(text: string, stablePrefix: string | undefined): number | undefined {
	if (stablePrefix === undefined || stablePrefix.length >= text.length || !text.startsWith(stablePrefix))
		return undefined;
	const code = text.charCodeAt(stablePrefix.length - 1);
	const boundary = code >= 0xd800 && code <= 0xdbff ? stablePrefix.length - 1 : stablePrefix.length;
	const stable = text.slice(0, boundary);
	const rest = text.slice(boundary);
	return HAS_VISIBLE_TEXT.test(stable) && HAS_VISIBLE_TEXT.test(rest) ? boundary : undefined;
}
