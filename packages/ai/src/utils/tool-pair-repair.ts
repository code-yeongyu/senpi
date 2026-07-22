import type { Message, TextContent } from "../types.ts";

export const TOOL_RESULT_PLACEHOLDER = "Tool output unavailable (context compacted)";

/**
 * Retry diagnostic for a dangling tool call flagged `incomplete` by the text
 * tool-call middleware (truncated and unrecoverable at stream end). Tells the
 * model the call never ran and should be re-issued with complete arguments.
 * Duplicated verbatim in the sibling pair-repair copy — the two packages
 * intentionally do not share this constant (no new cross-package dependency).
 */
function incompleteToolCallRetryText(name: string, errorMessage?: string): string {
	if (errorMessage !== undefined) {
		return `${errorMessage}${errorMessage.endsWith(".") ? "" : "."} Re-issue the tool call with complete arguments.`;
	}
	return `Tool call "${name}" was not executed: the response ended before the tool call was complete. Re-issue the tool call with complete arguments.`;
}

/** Repairs orphaned tool results and dangling tool calls. */
export function repairOrphanedToolResults(messages: Message[]): Message[] {
	const toolCallIds = new Set<string>();
	const toolResultIds = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") toolCallIds.add(block.id);
			}
		}
		if (message.role === "toolResult") toolResultIds.add(message.toolCallId);
	}

	const output: Message[] = [];
	const dangling = new Set([...toolCallIds].filter((id) => !toolResultIds.has(id)));

	for (const message of messages) {
		if (message.role === "toolResult") {
			if (!toolCallIds.has(message.toolCallId)) {
				output.push({
					...message,
					content: [{ type: "text", text: TOOL_RESULT_PLACEHOLDER }] satisfies TextContent[],
				});
				continue;
			}
			output.push(message);
			continue;
		}

		output.push(message);
		if (message.role === "assistant") {
			// Errored/aborted assistants are dropped downstream by transformMessages;
			// synthesizing results for their calls would only create orphans there.
			if (message.stopReason === "error" || message.stopReason === "aborted") continue;
			for (const block of message.content) {
				if (block.type !== "toolCall" || !dangling.has(block.id)) continue;
				const incomplete = block.incomplete === true;
				const text = incomplete
					? incompleteToolCallRetryText(block.name, block.errorMessage)
					: TOOL_RESULT_PLACEHOLDER;
				output.push({
					role: "toolResult",
					toolCallId: block.id,
					toolName: block.name,
					content: [{ type: "text", text }],
					isError: incomplete,
					timestamp: message.timestamp ? message.timestamp + 1 : Date.now(),
				});
				dangling.delete(block.id);
			}
		}
	}

	return output;
}
