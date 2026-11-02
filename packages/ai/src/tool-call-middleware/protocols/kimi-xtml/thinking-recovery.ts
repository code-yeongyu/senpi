import type { AssistantMessage, ThinkingContent } from "../../../types.ts";
import { createRecoveryCodeMask } from "../../recovery-code-mask.ts";
import { XTML_CHANNEL_MARKER_PATTERN } from "./markers.ts";

type OutputChannel = "thinking" | "response";

type RecoveredThinking = {
	readonly thinking: string;
	readonly response: string;
	readonly changed: boolean;
	readonly recoveredResponse: boolean;
};

const NAMED_MARKER_PATTERN = /^<\|(open|close)\|>([a-zA-Z_][a-zA-Z0-9_]*)?/;

function recoverThinkingContent(input: string): RecoveredThinking {
	const mask = createRecoveryCodeMask();
	let channel: OutputChannel = "thinking";
	let thinking = "";
	let response = "";
	let changed = false;
	let recoveredResponse = false;

	const append = (text: string): void => {
		if (channel === "response") response += text;
		else thinking += text;
	};

	const scan = (text: string): void => {
		let offset = 0;
		for (const match of text.matchAll(XTML_CHANNEL_MARKER_PATTERN)) {
			const index = match.index;
			if (index === undefined) continue;
			append(text.slice(offset, index));
			const named = NAMED_MARKER_PATTERN.exec(match[0]);
			const action = named?.[1];
			const name = named?.[2];
			changed = true;
			if (action === "open" && name === "response") {
				channel = "response";
				recoveredResponse = true;
			} else if (action === "open" && name === "think") {
				channel = "thinking";
			} else if (action === "close" && name === "response") {
				channel = "thinking";
			}
			offset = index + match[0].length;
		}
		append(text.slice(offset));
	};

	for (const segment of [...mask.feed(input), ...mask.finish()]) {
		if (segment.scan) scan(segment.text);
		else append(segment.text);
	}

	return { thinking, response, changed, recoveredResponse };
}

function recoveredThinkingBlock(block: ThinkingContent, thinking: string): ThinkingContent {
	return { ...block, thinking };
}

function strippedVisibleText(input: string): { readonly text: string; readonly changed: boolean } {
	const mask = createRecoveryCodeMask();
	let text = "";
	let changed = false;

	for (const segment of [...mask.feed(input), ...mask.finish()]) {
		if (!segment.scan) {
			text += segment.text;
			continue;
		}
		const stripped = segment.text.replace(XTML_CHANNEL_MARKER_PATTERN, "");
		if (stripped !== segment.text) changed = true;
		text += stripped;
	}

	return { text, changed };
}

export function recoverKimiXtmlThinking(message: AssistantMessage): AssistantMessage {
	let changed = false;
	let thinkingChanged = false;
	let recoveredResponse = false;
	const content: AssistantMessage["content"] = [];

	for (const block of message.content) {
		if (block.type === "text") {
			const stripped = strippedVisibleText(block.text);
			changed = changed || stripped.changed;
			content.push(stripped.changed ? { ...block, text: stripped.text } : block);
			continue;
		}
		if (block.type !== "thinking") {
			content.push(block);
			continue;
		}
		const recovered = recoverThinkingContent(block.thinking);
		changed = changed || recovered.changed;
		thinkingChanged = thinkingChanged || recovered.changed;
		recoveredResponse = recoveredResponse || recovered.recoveredResponse;
		content.push(recoveredThinkingBlock(block, recovered.thinking));
		if (recovered.response.length > 0) content.push({ type: "text", text: recovered.response });
	}

	if (!changed) return message;
	return {
		...message,
		content,
		diagnostics: thinkingChanged
			? [
					...(message.diagnostics ?? []),
					{
						type: "kimi_xtml_thinking_recovery",
						timestamp: Date.now(),
						details: { recoveredResponse },
					},
				]
			: message.diagnostics,
	};
}
