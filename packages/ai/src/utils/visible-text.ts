import type { AssistantMessage } from "../types.ts";

const INVISIBLE_FORMAT_CHARS = /\p{Cf}/gu;

export function hasVisibleText(text: string): boolean {
	return text.replace(INVISIBLE_FORMAT_CHARS, "").trim().length > 0;
}

export function hasVisibleAssistantContent(message: AssistantMessage): boolean {
	return message.content.some(
		(block) => block.type === "toolCall" || (block.type === "text" && hasVisibleText(block.text)),
	);
}
