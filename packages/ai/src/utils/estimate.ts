import type { AssistantMessage, ImageContent, Message, TextContent, TranscriptContext, Usage } from "../types.ts";
import { getSystemMessageText } from "./text.ts";
import { getCurrentTools } from "./transcript.ts";

export interface ContextUsageEstimate {
	/** Estimated total context tokens. */
	tokens: number;
	/** Tokens reported by the most recent applicable assistant usage block. */
	usageTokens: number;
	/** Estimated tokens after the most recent applicable assistant usage block. */
	trailingTokens: number;
	/** Index of the applicable message that provided usage, or null when none exists. */
	lastUsageIndex: number | null;
}

const CHARS_PER_TOKEN = 4;
const ESTIMATED_IMAGE_CHARS = 4800;

/**
 * Whether a UTF-16 code unit belongs to a script tokenizers spend about one token per character on: Hangul jamo and
 * syllables, CJK radicals, punctuation, kana and ideographs (incl. extension A), compatibility ideographs and
 * fullwidth forms. Latin-script text runs near four characters per token; counting these at that rate undercounts
 * CJK-heavy prompts by 2-4x, so every guard built on the estimate acts too late (senpi#3032).
 */
function isWideScriptCodeUnit(code: number): boolean {
	return (
		(code >= 0x1100 && code <= 0x11ff) ||
		(code >= 0x2e80 && code <= 0x9fff) ||
		(code >= 0xa960 && code <= 0xa97f) ||
		(code >= 0xac00 && code <= 0xd7ff) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xff00 && code <= 0xffef)
	);
}

/** Length in Latin-equivalent characters: a wide-script character weighs one token (`CHARS_PER_TOKEN`). */
function weightedLength(text: string): number {
	let wide = 0;
	for (let index = 0; index < text.length; index++) {
		if (isWideScriptCodeUnit(text.charCodeAt(index))) wide++;
	}
	return text.length + wide * (CHARS_PER_TOKEN - 1);
}

export function calculateContextTokens(usage: Usage): number {
	if (usage.contextUsage !== undefined) {
		return usage.contextUsage === null ? 0 : usage.contextUsage.input + usage.contextUsage.output;
	}
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function estimateTextAndImageContentChars(content: string | Array<TextContent | ImageContent>): number {
	if (typeof content === "string") return weightedLength(content);

	let chars = 0;
	for (const block of content) chars += block.type === "text" ? weightedLength(block.text) : ESTIMATED_IMAGE_CHARS;
	return chars;
}

export function estimateTextTokens(text: string): number {
	return Math.ceil(weightedLength(text) / CHARS_PER_TOKEN);
}

export function estimateTextAndImageContentTokens(content: string | Array<TextContent | ImageContent>): number {
	return Math.ceil(estimateTextAndImageContentChars(content) / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(message: Message): number {
	let chars = 0;

	if (message.role === "system") {
		return (
			estimateTextTokens(getSystemMessageText(message)) +
			estimateToolsTokens(message.toolsAdded) +
			estimateToolsTokens(message.toolsRemoved)
		);
	}
	if (message.role === "user") return estimateTextAndImageContentTokens(message.content);
	if (message.role === "toolResult") return estimateTextAndImageContentTokens(message.content);
	if (message.role === "configurationUpdate") return 0;

	for (const block of message.content) {
		if (block.type === "text") {
			chars += weightedLength(block.text);
		} else if (block.type === "thinking") {
			chars += weightedLength(block.thinking);
		} else if (block.type === "toolCall") {
			chars += block.name.length + weightedLength(safeJsonStringify(block.arguments));
		} else {
			chars += block.subtype.length + weightedLength(safeJsonStringify(block.raw));
		}
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

function getLastAssistantUsageInfo(messages: readonly Message[]): { usage: Usage; index: number } | undefined {
	let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
	let usageInfo: { usage: Usage; index: number } | undefined;

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		if (message.role === "assistant") {
			const assistant = message as AssistantMessage;
			// A newer prefix message was inserted after this response (for example, a
			// compaction summary), so its usage cannot describe the current prefix.
			const usageAppliesToPrefix = assistant.timestamp >= latestPrefixTimestamp;
			if (
				usageAppliesToPrefix &&
				assistant.stopReason !== "aborted" &&
				assistant.stopReason !== "error" &&
				calculateContextTokens(assistant.usage) > 0
			) {
				usageInfo = { usage: assistant.usage, index: i };
			}
		}
		latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
	}

	return usageInfo;
}

export function estimateContextTokens(context: TranscriptContext | readonly Message[]): ContextUsageEstimate {
	const messages = "messages" in context ? context.messages : context;
	const usageInfo = getLastAssistantUsageInfo(messages);
	if (usageInfo) {
		const usageTokens = calculateContextTokens(usageInfo.usage);
		let trailingTokens = estimateLazilyAddedToolsTokens(messages, usageInfo.index);
		for (let i = usageInfo.index + 1; i < messages.length; i++) {
			trailingTokens += estimateMessageTokens(messages[i]);
		}
		return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: usageInfo.index };
	}

	let tokens = 0;
	for (const message of messages) tokens += estimateMessageTokens(message);
	return { tokens, usageTokens: 0, trailingTokens: tokens, lastUsageIndex: null };
}

/**
 * Tools a later tool result activated (`addedToolNames`, fork lazy activation) are declared in the
 * leading system message, before the last billed usage, yet were never billed: count them as trailing.
 */
function estimateLazilyAddedToolsTokens(messages: readonly Message[], lastUsageIndex: number): number {
	const addedNames = new Set(
		messages
			.slice(lastUsageIndex + 1)
			.flatMap((message) => (message.role === "toolResult" ? (message.addedToolNames ?? []) : [])),
	);
	if (addedNames.size === 0) return 0;
	return estimateToolsTokens(getCurrentTools(messages).filter((tool) => addedNames.has(tool.name)));
}

function estimateToolsTokens(tools: readonly unknown[] | undefined): number {
	if (!tools || tools.length === 0) return 0;
	return estimateTextTokens(safeJsonStringify(tools));
}
