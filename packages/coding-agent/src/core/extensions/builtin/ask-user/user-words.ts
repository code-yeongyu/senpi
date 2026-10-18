import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ToolResultUserWord } from "../../../tool-result-user-words.ts";

/**
 * Where an answer's own words go (senpi#2920): inline for people (hooks, the transcript card), or
 * out of the model-facing text behind a reference that names the label block they follow, so they
 * reach the model as a user turn and never inside a tool result or beside a harness label.
 */
export interface WordPlacement {
	comment(text: string): string;
	typed(header: string, text: string): string;
}

export const INLINE_WORDS: WordPlacement = { comment: (text) => text, typed: (_header, text) => text };

const reference = (label: string) => `(see [${label}] below)`;

export function separatedWords(requestId: string): WordPlacement & { readonly words: ToolResultUserWord[] } {
	const words: ToolResultUserWord[] = [];
	const place = (base: string, text: string) => {
		const taken = words.filter((word) => word.label === base || word.label.startsWith(`${base} (`)).length;
		const label = taken === 0 ? base : `${base} (${taken + 1})`;
		words.push({ label, text });
		return reference(label);
	};
	return {
		words,
		comment: (text) => place(`The user's comment for question ${requestId}`, text),
		typed: (header, text) => place(`The user's answer to ${header} for question ${requestId}`, text),
	};
}

/** Puts each word back where its reference stands, for display. */
export function resolveUserWordReferences(text: string, words: readonly ToolResultUserWord[]): string {
	return words.reduce((resolved, word) => resolved.split(reference(word.label)).join(word.text), text);
}

/** The label and word blocks after a later answer's frame block, as `userWordBlocks` wrote them. */
export function readUserWordBlocks(content: readonly (TextContent | ImageContent)[]): ToolResultUserWord[] | undefined {
	const texts = content.flatMap((block) => (block.type === "text" ? [block.text] : []));
	if (texts.length % 2 !== 0) return undefined;
	const words: ToolResultUserWord[] = [];
	for (let index = 0; index < texts.length; index += 2) {
		const label = /^\[(.+)\]$/s.exec(texts[index] ?? "")?.[1];
		const text = texts[index + 1];
		if (label === undefined || text === undefined) return undefined;
		words.push({ label, text });
	}
	return words;
}
