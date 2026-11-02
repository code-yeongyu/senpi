import type { TextContent } from "@earendil-works/pi-ai";
import { parseAskUserAnswerFrame } from "./extensions/builtin/ask-user/format.ts";

/** The one text a user message's text blocks spell: the blocks joined by a newline. */
export function joinUserTextBlocks(blocks: readonly string[]): string {
	return blocks.join("\n");
}

/**
 * The text a queued user message is tracked by. The queue records it on enqueue and matches the
 * started message's content against it on delivery, so both sides must read it here (senpi#3588):
 * `userMessageText(userTextContent(text, textBlocks)) === text` for every queued `text`.
 */
export function userMessageText(content: string | readonly { type: string; text?: string }[]): string {
	if (typeof content === "string") return content;
	const blocks: string[] = [];
	for (const part of content) if (part.type === "text" && part.text !== undefined) blocks.push(part.text);
	return joinUserTextBlocks(blocks);
}

/**
 * The text content of a user message. Text that arrived as several blocks keeps them while they
 * still spell the final text exactly (joined by a newline); text that an input handler or a
 * template expansion rewrote becomes one block. This keeps a harness label and the user's own
 * words in separate blocks (senpi#2920).
 */
export function userTextContent(text: string, textBlocks?: readonly string[]): TextContent[] {
	if (textBlocks !== undefined && textBlocks.length > 1 && joinUserTextBlocks(textBlocks) === text) {
		return textBlocks.map((block) => ({ type: "text", text: block }));
	}
	return [{ type: "text", text }];
}

/**
 * A later ask-user answer arrives as its frame block followed by labelled word blocks. An `input`
 * rewrite of the joined text would fuse the harness frame and the user's words into one block
 * (senpi#2920), so such a message keeps its blocks and is not rewritten.
 */
export function keepsTextBlocksVerbatim(textBlocks: readonly string[] | undefined): boolean {
	return (
		textBlocks !== undefined && textBlocks.length > 1 && parseAskUserAnswerFrame(textBlocks[0] ?? "") !== undefined
	);
}
