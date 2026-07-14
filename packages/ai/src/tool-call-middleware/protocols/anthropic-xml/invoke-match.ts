import type { InvokeBlockMatch, InvokeOpenTagMatch } from "./invoke-tag-scanner.ts";
import { findInvokeOpenTag, scanInvokeBlock } from "./invoke-tag-scanner.ts";

export type InvokeMatch = {
	readonly openingTag: InvokeOpenTagMatch;
	readonly block: InvokeBlockMatch | null;
};

export function findNextInvokeMatch(
	text: string,
	fromIndex: number,
	matchesToolName: (toolName: string) => boolean,
): InvokeMatch | null {
	let cursor = Math.max(0, fromIndex);
	while (cursor < text.length) {
		const openingTag = findInvokeOpenTag(text, cursor);
		if (!openingTag) {
			return null;
		}
		if (matchesToolName(openingTag.toolName)) {
			return { openingTag, block: scanInvokeBlock(text, openingTag) };
		}
		cursor = openingTag.index + openingTag.length;
	}
	return null;
}
