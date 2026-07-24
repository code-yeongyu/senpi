/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";

export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

export const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;

export const BRANCH_SUMMARY_SUFFIX = `</summary>`;

export function isContextExcludedCustomMessage(_customType: string): boolean {
	return false;
}

export function filterContextExcludedMessages(messages: AgentMessage[]): AgentMessage[] {
	return messages;
}

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	fullOutputPath?: string;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for extension-injected messages via sendMessage().
 * These are custom messages that extensions can inject into the conversation.
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	tokensBefore: number;
	details?: unknown;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
declare module "@earendil-works/pi-agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		custom: CustomMessage;
		branchSummary: BranchSummaryMessage;
	}
}

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nCommand exited with code ${msg.exitCode}`;
	}
	if (msg.truncated && msg.fullOutputPath) {
		text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
	}
	return text;
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
	details?: unknown,
): CompactionSummaryMessage {
	return {
		role: "compactionSummary",
		summary: summary,
		tokensBefore,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Convert CustomMessageEntry to AgentMessage format */
export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		timestamp: new Date(timestamp).getTime(),
	};
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages
		.map((m): Message | undefined => {
			switch (m.role) {
				case "bashExecution":
					// Skip messages excluded from context (!! prefix)
					if (m.excludeFromContext) {
						return undefined;
					}
					return {
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						timestamp: m.timestamp,
					};
				case "custom": {
					if (isContextExcludedCustomMessage(m.customType)) {
						return undefined;
					}

					const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
					return {
						role: "user",
						content,
						timestamp: m.timestamp,
					};
				}
				case "branchSummary":
					return {
						role: "user",
						content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
						timestamp: m.timestamp,
					};
				case "compactionSummary":
					return {
						role: "user",
						content: [
							{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX },
						],
						timestamp: m.timestamp,
					};
				case "user":
				case "assistant":
				case "toolResult":
					return m;
				default:
					// biome-ignore lint/correctness/noSwitchDeclarations: fine
					const _exhaustiveCheck: never = m;
					return undefined;
			}
		})
		.filter((m) => m !== undefined);
}

// ============================================================================
// Transport image budget
// ============================================================================

/**
 * Cap on inline image base64 (characters approximately equal wire bytes) per
 * provider request. Anthropic documents a 32 MB request limit; reserving the
 * remainder for text and request overhead keeps the transport below that wall.
 */
export const TRANSPORT_IMAGE_BUDGET_BYTES = 24 * 1024 * 1024;

export const IMAGE_ELISION_PLACEHOLDER =
	"[Image elided: an older image was removed to keep the request within the provider's size limit. Re-read the source file if you need to view it again.]";

export const BLOCKED_IMAGE_PLACEHOLDER = "Image reading is disabled.";

export interface ElideOldImagesOptions {
	/** Cumulative inline image base64 budget. Defaults to TRANSPORT_IMAGE_BUDGET_BYTES. */
	budgetBytes?: number;
	/** Newest image blocks always kept regardless of budget. They still consume it. Defaults to 1. */
	alwaysKeepNewest?: number;
}

export interface TransportConvertOptions extends ElideOldImagesOptions {
	/** Replace every image when the images.blockImages setting is enabled. */
	blockImages: boolean;
}

/** Drop consecutive duplicates of a placeholder produced by adjacent image replacements. */
export function dedupeConsecutivePlaceholder(
	content: (TextContent | ImageContent)[],
	placeholder: string,
): (TextContent | ImageContent)[] {
	return content.filter(
		(block, index, blocks) =>
			!(
				block.type === "text" &&
				block.text === placeholder &&
				index > 0 &&
				blocks[index - 1].type === "text" &&
				(blocks[index - 1] as TextContent).text === placeholder
			),
	);
}

/**
 * Bound inline image payload at request-build time. Images are considered from
 * newest to oldest. Once an image would exceed the budget, it and every older
 * image are replaced by a text placeholder. The newest protected blocks are
 * kept regardless of size, but still consume the budget.
 *
 * The input and persisted session remain untouched. If every image fits, the
 * original array reference is returned.
 */
export function elideOldImages(messages: Message[], options?: ElideOldImagesOptions): Message[] {
	const budgetBytes = options?.budgetBytes ?? TRANSPORT_IMAGE_BUDGET_BYTES;
	const alwaysKeepNewest = options?.alwaysKeepNewest ?? 1;
	const imagesToElide = new Set<string>();
	let keptImages = 0;
	let imageBytes = 0;
	let cutoffReached = false;

	for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex--) {
		const message = messages[messageIndex];
		if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) {
			continue;
		}

		for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex--) {
			const block = message.content[blockIndex];
			if (block.type !== "image") continue;

			if (cutoffReached) {
				imagesToElide.add(`${messageIndex}:${blockIndex}`);
				continue;
			}

			if (keptImages < alwaysKeepNewest || imageBytes + block.data.length <= budgetBytes) {
				keptImages++;
				imageBytes += block.data.length;
				continue;
			}

			cutoffReached = true;
			imagesToElide.add(`${messageIndex}:${blockIndex}`);
		}
	}

	if (imagesToElide.size === 0) return messages;

	return messages.map((message, messageIndex) => {
		if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) {
			return message;
		}
		if (!message.content.some((_block, blockIndex) => imagesToElide.has(`${messageIndex}:${blockIndex}`))) {
			return message;
		}

		const replaced = message.content.map((block, blockIndex): TextContent | ImageContent =>
			imagesToElide.has(`${messageIndex}:${blockIndex}`) ? { type: "text", text: IMAGE_ELISION_PLACEHOLDER } : block,
		);
		return {
			...message,
			content: dedupeConsecutivePlaceholder(replaced, IMAGE_ELISION_PLACEHOLDER) as typeof message.content,
		};
	});
}

/** Convert messages for the main provider transport and apply its image policy. */
export function convertToLlmForTransport(messages: AgentMessage[], options: TransportConvertOptions): Message[] {
	const converted = convertToLlm(messages);
	if (!options.blockImages) return elideOldImages(converted, options);

	return converted.map((message) => {
		if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) {
			return message;
		}
		if (!message.content.some((block) => block.type === "image")) return message;

		const replaced = message.content.map((block): TextContent | ImageContent =>
			block.type === "image" ? { type: "text", text: BLOCKED_IMAGE_PLACEHOLDER } : block,
		);
		return {
			...message,
			content: dedupeConsecutivePlaceholder(replaced, BLOCKED_IMAGE_PLACEHOLDER) as typeof message.content,
		};
	});
}
