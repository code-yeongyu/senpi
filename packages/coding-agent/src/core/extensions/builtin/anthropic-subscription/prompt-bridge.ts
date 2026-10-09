import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { replayHistoryImages } from "./cold-seed-images.ts";
import { appendSdkContentBlocks } from "./content-blocks.ts";
import type { PromptCacheTtl } from "./prompt-cache-ttl.ts";
import type { ContentBlockParam, SDKUserMessage } from "./sdk-boundary.ts";
import { mapPiToolNameToSdk } from "./tools.ts";

export { mapPiToolNameToSdk } from "./tools.ts";

export function contentToText(
	content: AssistantMessage["content"],
	customToolNameToSdk?: ReadonlyMap<string, string>,
): string {
	return content
		.map((block) => {
			if (block.type === "text") return block.text;
			if (block.type === "thinking") return block.thinking;
			if (block.type === "toolCall") {
				return `Historical tool call (non-executable): ${mapPiToolNameToSdk(block.name, customToolNameToSdk)} args=${JSON.stringify(block.arguments)}`;
			}
			return `[${block.type}]`;
		})
		.join("\n");
}

function appendContentBlocks(blocks: ContentBlockParam[], content: string | readonly unknown[]): boolean {
	return appendSdkContentBlocks(blocks, content);
}

/**
 * Text that closes the replayed history. Everything after it (recovered tool results, the
 * response instruction, the final user message) changes every turn, so it stays after the
 * cache breakpoint.
 */
export const CONVERSATION_HISTORY_CLOSER = "\n</conversation_history>";

export type PromptBlockOptions = {
	/**
	 * Mark the last history text block as a prompt-cache breakpoint with this lifetime. History only grows by
	 * appending, so the next rebuilt prompt starts with the same bytes up to here and reads them from cache
	 * (senpi#2982). The lifetime must equal the one Claude Code is pinned to (see prompt-cache-ttl.ts). Only for
	 * one-shot queries: a resident session keeps this user message in its transcript, where Claude Code adds its own.
	 */
	cacheBreakpoint?: PromptCacheTtl;
};

/** Claude Code drops a breakpoint set on an image, so the last text block of the history carries it. */
function markCacheBreakpoint(blocks: ContentBlockParam[], historyStart: number, ttl: PromptCacheTtl): void {
	for (let index = blocks.length - 1; index >= historyStart; index--) {
		const block = blocks[index];
		if (block?.type !== "text") continue;
		blocks[index] = { ...block, cache_control: { type: "ephemeral", ttl } };
		return;
	}
}

export function buildPromptBlocks(
	context: Context,
	customToolNameToSdk?: ReadonlyMap<string, string>,
	toolWatchNote?: string,
	options: PromptBlockOptions = {},
): ContentBlockParam[] {
	const blocks: ContentBlockParam[] = [];
	const pushText = (text: string): void => {
		blocks.push({ type: "text", text });
	};
	const finalMessage = context.messages.at(-1);
	const finalUserMessage = finalMessage?.role === "user" ? finalMessage : undefined;
	const history = finalUserMessage ? context.messages.slice(0, -1) : context.messages;

	if (history.length > 0) {
		const historyStart = blocks.length;
		pushText("<conversation_history>\n");
		let hasPreviousTurn = false;
		const pushPrefix = (label: string): void => {
			pushText(`${hasPreviousTurn ? "\n\n" : ""}${label}\n`);
			hasPreviousTurn = true;
		};

		const replayedImages = replayHistoryImages(history, (name) => mapPiToolNameToSdk(name, customToolNameToSdk));
		for (const [index, message] of history.entries()) {
			if (message.role === "user") {
				pushPrefix("USER:");
				if (!appendContentBlocks(blocks, replayedImages.get(index) ?? message.content))
					pushText("(see attached image)");
				continue;
			}
			if (message.role === "assistant") {
				pushPrefix("ASSISTANT:");
				const text = contentToText(message.content, customToolNameToSdk);
				if (text.length > 0) pushText(text);
				continue;
			}
			if (message.role === "configurationUpdate" || message.role === "system") continue;
			pushPrefix(
				`TOOL RESULT (historical ${mapPiToolNameToSdk(message.toolName, customToolNameToSdk)}, id=${message.toolCallId}):`,
			);
			if (!appendContentBlocks(blocks, replayedImages.get(index) ?? message.content))
				pushText("(see attached image)");
		}
		if (options.cacheBreakpoint !== undefined) markCacheBreakpoint(blocks, historyStart, options.cacheBreakpoint);
		pushText(CONVERSATION_HISTORY_CLOSER);
	}

	if (toolWatchNote?.trim()) {
		pushText("<recovered_tool_results>\n");
		pushText(toolWatchNote.trim());
		pushText("\n</recovered_tool_results>");
	}
	pushText(
		'The above is the conversation history so far, provided as context. Respond as the assistant to the user message below only. Never emit "USER:" or "ASSISTANT:" labels or continue the transcript.',
	);
	if (finalUserMessage && !appendContentBlocks(blocks, finalUserMessage.content)) pushText("(see attached image)");
	return blocks;
}

/**
 * A prompt that builds its blocks each time it is iterated. A failover retry hands the same prompt to a fresh query,
 * and an async generator would be exhausted by then; building late also lets the blocks follow the auth lane the
 * attempt resolved (its pinned cache lifetime).
 */
export function buildDeferredPromptStream(build: () => ContentBlockParam[]): AsyncIterable<SDKUserMessage> {
	return { [Symbol.asyncIterator]: () => buildPromptStream(build())[Symbol.asyncIterator]() };
}

export function buildPromptStream(promptBlocks: ContentBlockParam[]): AsyncIterable<SDKUserMessage> {
	return (async function* () {
		yield {
			type: "user",
			message: { role: "user", content: promptBlocks } as SDKUserMessage["message"],
			parent_tool_use_id: null,
			session_id: "prompt",
		};
	})();
}
