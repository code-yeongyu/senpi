import type { AssistantMessage } from "@earendil-works/pi-ai";
import { LEAK_ERROR_MESSAGE, renderSystemInterrupt } from "./prompts.ts";
import { TTSR_INJECTION_CUSTOM_TYPE } from "./types.ts";

const TRUNCATION_MARKER = "[output interrupted by stream rule]";
const TRANSPORT_TIMEOUT_ERROR_PATTERN = /^Request timed out\.?$/i;

export type TruncatableAssistantMessage = AssistantMessage;
export type ErrorShellReplacement = {
	readonly role: "assistant";
	readonly content: never[];
	readonly stopReason: "error";
	readonly errorMessage: string;
};

export interface TtsrNudgeMessage {
	readonly customType: typeof TTSR_INJECTION_CUSTOM_TYPE;
	readonly content: string;
	readonly display: false;
	readonly details: { readonly rules: readonly string[] };
}

type StreamKind = "text" | "thinking" | "tool";

function streamBlockText(block: unknown, kind: StreamKind): string | undefined {
	if (kind === "tool") return undefined;
	if (typeof block !== "object" || block === null) return undefined;
	if (!("type" in block) || block.type !== kind) return undefined;
	const value: unknown = Reflect.get(block, kind);
	return typeof value === "string" ? value : undefined;
}

function replaceStreamBlockText(
	block: AssistantMessage["content"][number],
	kind: StreamKind,
	text: string,
): AssistantMessage["content"][number] {
	if (kind === "text" && block.type === "text") return { ...block, text };
	if (kind === "thinking" && block.type === "thinking") return { ...block, thinking: text };
	return block;
}

export function buildTruncateReplacement(
	message: TruncatableAssistantMessage,
	garbageStartOffset: number,
	streamKind: StreamKind,
): TruncatableAssistantMessage {
	if (streamKind === "tool") {
		const content = message.content.filter((block) => {
			if (typeof block !== "object" || block === null || !("type" in block)) return true;
			return block.type !== "toolCall";
		});
		return {
			...message,
			content: [...content, { type: "text", text: TRUNCATION_MARKER }],
			stopReason: message.stopReason === "toolUse" ? "aborted" : message.stopReason,
		};
	}
	let remaining = Math.max(0, garbageStartOffset);
	let truncated = false;
	const content: AssistantMessage["content"] = [];
	for (const block of message.content) {
		const text = streamBlockText(block, streamKind);
		if (truncated && text !== undefined) continue;
		if (text === undefined || remaining > text.length) {
			content.push(block);
			if (text !== undefined) remaining -= text.length;
			continue;
		}
		content.push(replaceStreamBlockText(block, streamKind, text.slice(0, remaining)));
		truncated = true;
	}
	content.push({ type: "text", text: TRUNCATION_MARKER });
	const result: AssistantMessage = { ...message, content };
	if (result.errorMessage !== undefined && TRANSPORT_TIMEOUT_ERROR_PATTERN.test(result.errorMessage)) {
		delete result.errorMessage;
	}
	return result;
}

export function buildErrorShellReplacement(): ErrorShellReplacement {
	return { role: "assistant", content: [], stopReason: "error", errorMessage: LEAK_ERROR_MESSAGE };
}

export function buildNudgeMessage(ruleName: string, ruleContent: string): TtsrNudgeMessage {
	return {
		customType: TTSR_INJECTION_CUSTOM_TYPE,
		content: renderSystemInterrupt(ruleName, ruleContent),
		display: false,
		details: { rules: [ruleName] },
	};
}
