import { createHash } from "node:crypto";
import type { ImageContent, Message, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
import type { AcpContentBlock } from "./acp-client.ts";

const IMAGE_OMITTED = "[image omitted: text digest]";

const BOOTSTRAP_INTRO = "The conversation so far (replayed by senpi; do not answer it, only use it as context):\n\n";
const NEW_MESSAGE_HEADER = "\n\nNew message (answer this):\n\n";

// Keep bootstrap history safely compact so trailing prompt and images fit well inside agy limits.
const MAX_BOOTSTRAP_CHARS = 120_000;
const MAX_HISTORY_TOOL_RESULT_CHARS = 1_500;
const MAX_HISTORY_TOOL_CALL_ARGS_CHARS = 600;
const MAX_HISTORY_TEXT_CHARS = 6_000;

export function renderMessagesAsText(messages: readonly Message[]): string {
	const blocks: string[] = [];
	for (const message of messages) {
		blocks.push(...renderMessageBlocks(message, false));
	}
	return blocks.join("\n");
}

export function renderUserTurn(messages: readonly Message[]): string {
	const only = messages.length === 1 ? messages[0] : undefined;
	if (only !== undefined && only.role === "user") return userBodyText(only.content);
	return renderMessagesAsText(messages);
}

export function renderUserTurnBlocks(messages: readonly Message[]): AcpContentBlock[] {
	const blocks: AcpContentBlock[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			appendTextAndImageBlocks(blocks, message.content);
			continue;
		}
		if (message.role === "toolResult") {
			const header = `<tool_result name="${escapeAttribute(message.toolName)}" error="${message.isError ? "true" : "false"}">\n`;
			appendTextBlock(blocks, header);
			appendTextAndImageBlocks(blocks, message.content);
			appendTextBlock(blocks, "\n</tool_result>");
			continue;
		}
		const text = renderMessageBlocks(message, false).join("\n");
		if (text.length > 0) appendTextBlock(blocks, text);
	}
	if (blocks.length === 0) blocks.push({ type: "text", text: "" });
	return blocks;
}

export function renderBootstrap(history: readonly Message[], newMessages: readonly Message[]): string {
	const newTurnText = renderUserTurn(newMessages);
	if (history.length === 0) return newTurnText;

	const historyText = renderCompactHistoryText(history, newTurnText.length);
	return `${BOOTSTRAP_INTRO}${historyText}${NEW_MESSAGE_HEADER}${newTurnText}`;
}

export function renderBootstrapBlocks(history: readonly Message[], newMessages: readonly Message[]): AcpContentBlock[] {
	const newBlocks = renderUserTurnBlocks(newMessages);
	if (history.length === 0) return newBlocks;

	const newTextLength = newBlocks.reduce((sum, b) => sum + (b.type === "text" ? b.text.length : 256), 0);
	const historyText = renderCompactHistoryText(history, newTextLength);
	const blocks: AcpContentBlock[] = [{ type: "text", text: `${BOOTSTRAP_INTRO}${historyText}${NEW_MESSAGE_HEADER}` }];
	for (const block of newBlocks) {
		if (block.type === "text") {
			appendTextBlock(blocks, block.text, "");
		} else {
			blocks.push(block);
		}
	}
	return blocks;
}

export function renderLateToolResultBlocks(
	results: readonly ToolResultMessage[],
	steering: readonly Message[],
	options?: { readonly reason?: "timeout" | "config-refresh" },
): AcpContentBlock[] {
	const intro =
		options?.reason === "config-refresh"
			? "Results for your earlier host tool call(s) (the host tool list was refreshed; call any newly activated tools via their mcp_senpi-host_<name> names):\n\n"
			: "Results for your earlier host tool call(s) whose MCP wait timed out while senpi finished running them:\n\n";
	const blocks: AcpContentBlock[] = [
		{
			type: "text",
			text: intro,
		},
	];
	for (const result of results) {
		const name = escapeAttribute(result.toolName);
		const id = escapeAttribute(result.toolCallId);
		const err = result.isError ? "true" : "false";
		appendTextBlock(blocks, `<tool_result id="${id}" name="${name}" error="${err}">\n`, "");
		appendTextAndImageBlocks(blocks, result.content);
		appendTextBlock(blocks, "\n</tool_result>\n", "");
	}
	if (steering.length > 0) {
		appendTextBlock(blocks, "\n[message from the user while the tool ran]\n", "");
		for (const block of renderUserTurnBlocks(steering)) {
			if (block.type === "text") appendTextBlock(blocks, block.text, "");
			else blocks.push(block);
		}
	}
	return blocks;
}

function renderCompactHistoryText(history: readonly Message[], reservedChars: number): string {
	const overhead = BOOTSTRAP_INTRO.length + NEW_MESSAGE_HEADER.length + 128;
	const historyBudget = Math.max(0, MAX_BOOTSTRAP_CHARS - reservedChars - overhead);
	if (historyBudget <= 0) {
		return `[... ${history.length} earlier messages omitted to stay within agy input limit ...]`;
	}

	const renderedHistory: string[] = [];
	for (const message of history) {
		const compact = renderMessageBlocks(message, true).join("\n");
		if (compact.length > 0) renderedHistory.push(compact);
	}

	const keptReversed: string[] = [];
	let used = 0;
	let omitted = 0;
	for (let index = renderedHistory.length - 1; index >= 0; index -= 1) {
		const block = renderedHistory[index]!;
		const cost = block.length + (keptReversed.length > 0 ? 1 : 0);
		if (used + cost > historyBudget) {
			omitted = index + 1;
			break;
		}
		keptReversed.push(block);
		used += cost;
	}
	keptReversed.reverse();
	const prefix = omitted > 0 ? `[... ${omitted} earlier messages omitted to stay within agy input limit ...]\n` : "";
	return `${prefix}${keptReversed.join("\n")}`;
}

function appendTextBlock(blocks: AcpContentBlock[], text: string, separator = "\n"): void {
	if (!text) return;
	const last = blocks[blocks.length - 1];
	if (last?.type === "text") {
		const sep = last.text.length > 0 ? separator : "";
		blocks[blocks.length - 1] = { type: "text", text: `${last.text}${sep}${text}` };
		return;
	}
	blocks.push({ type: "text", text });
}

function appendTextAndImageBlocks(
	blocks: AcpContentBlock[],
	content: string | readonly (TextContent | ImageContent)[],
): void {
	if (typeof content === "string") {
		appendTextBlock(blocks, content);
		return;
	}
	for (const part of content) {
		if (part.type === "text") {
			appendTextBlock(blocks, part.text);
		} else if (part.type === "image") {
			blocks.push({ type: "image", data: part.data, mimeType: part.mimeType });
		}
	}
}

function renderMessageBlocks(message: Message, compact: boolean): readonly string[] {
	switch (message.role) {
		case "user": {
			const text = userBodyText(message.content);
			return [`<user>\n${compact ? clip(text, MAX_HISTORY_TEXT_CHARS) : text}\n</user>`];
		}
		case "assistant":
			return renderAssistant(message, compact);
		case "toolResult":
			return [renderToolResult(message, compact)];
		case "system":
		case "configurationUpdate":
			return [];
		default:
			return [];
	}
}

function userBodyText(content: string | readonly (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return textAndImageText(content);
}

function textAndImageText(blocks: readonly (TextContent | ImageContent)[]): string {
	const parts: string[] = [];
	for (const block of blocks) {
		if (block.type === "text") {
			parts.push(block.text);
		} else if (block.type === "image") {
			const digest = createHash("sha256").update(block.data, "utf8").digest("hex").slice(0, 12);
			parts.push(`${IMAGE_OMITTED}:${block.mimeType}:${digest}`);
		}
	}
	return parts.join("\n");
}

function renderAssistant(message: Extract<Message, { role: "assistant" }>, compact: boolean): readonly string[] {
	const blocks: string[] = [];
	for (const block of message.content) {
		if (block.type === "text") {
			const text = compact ? clip(block.text, MAX_HISTORY_TEXT_CHARS) : block.text;
			blocks.push(`<assistant>\n${text}\n</assistant>`);
		} else if (block.type === "toolCall") {
			const name = escapeAttribute(block.name);
			const rawArgs = JSON.stringify(block.arguments);
			const args = compact ? clip(rawArgs, MAX_HISTORY_TOOL_CALL_ARGS_CHARS) : rawArgs;
			blocks.push(`<tool_call name="${name}">\n${args}\n</tool_call>`);
		}
	}
	return blocks;
}

function renderToolResult(message: Extract<Message, { role: "toolResult" }>, compact: boolean): string {
	const name = escapeAttribute(message.toolName);
	const error = message.isError ? "true" : "false";
	const rawBody = textAndImageText(message.content);
	const body = compact ? clip(rawBody, MAX_HISTORY_TOOL_RESULT_CHARS) : rawBody;
	return `<tool_result name="${name}" error="${error}">\n${body}\n</tool_result>`;
}

function clip(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	const omitted = value.length - maxChars;
	const head = Math.floor(maxChars * 0.75);
	const tail = maxChars - head;
	return `${value.slice(0, head)}\n[... ${omitted} chars omitted ...]\n${value.slice(value.length - tail)}`;
}

function escapeAttribute(value: string): string {
	return value.split("&").join("&amp;").split('"').join("&quot;").split("<").join("&lt;");
}
