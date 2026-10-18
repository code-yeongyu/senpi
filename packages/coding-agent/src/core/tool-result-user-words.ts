import {
	CONTEXT_PROVENANCE_FIELD,
	contextProvenanceFingerprint,
	getContextProvenance,
	type Message,
	type TextContent,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";

/**
 * Words the user typed that a tool result carries in `details.userWords` instead of its content.
 * A model trained to distrust tool results may ignore user text inside one (senpi#2920), so each
 * request delivers them as a user turn after the tool results, every word after its own label.
 */
export interface ToolResultUserWord {
	readonly label: string;
	readonly text: string;
}

function isUserWord(value: unknown): value is ToolResultUserWord {
	return (
		typeof value === "object" &&
		value !== null &&
		"label" in value &&
		typeof value.label === "string" &&
		"text" in value &&
		typeof value.text === "string"
	);
}

export function toolResultUserWords(
	message: Pick<ToolResultMessage, "details"> | { details: unknown },
): ToolResultUserWord[] {
	const details: unknown = message.details;
	if (typeof details !== "object" || details === null || !("userWords" in details)) return [];
	return Array.isArray(details.userWords) ? details.userWords.filter(isUserWord) : [];
}

/** The label block a reference names, then the words, for each word in order. */
export function userWordBlocks(words: readonly ToolResultUserWord[]): TextContent[] {
	return words.flatMap((word): TextContent[] => [
		{ type: "text", text: `[${word.label}]` },
		{ type: "text", text: word.text },
	]);
}

/**
 * Inserts one user message after each contiguous run of tool results whose details carry user
 * words. It is derived only from persisted tool results, so live requests, resumed sessions and
 * compaction all see the same messages, and no queue operation can drop them.
 */
export function appendToolResultUserWords(messages: Message[]): Message[] {
	if (!messages.some((message) => message.role === "toolResult" && toolResultUserWords(message).length > 0)) {
		return messages;
	}
	const result: Message[] = [];
	let pending: TextContent[] = [];
	let source: ToolResultMessage | undefined;
	const flush = (next: Message | undefined) => {
		if (source && !startsWithBlocks(next, pending)) result.push(wordMessage(pending, source));
		pending = [];
		source = undefined;
	};
	for (const message of messages) {
		if (message.role !== "toolResult") flush(message);
		result.push(message);
		if (message.role !== "toolResult") continue;
		const blocks = userWordBlocks(toolResultUserWords(message));
		if (blocks.length === 0) continue;
		pending.push(...blocks);
		source = message;
	}
	flush(undefined);
	return result;
}

/**
 * The word message belongs to its tool result: it carries its own copy of that result's
 * request-local provenance, so a context producer that marks the result (OpenAI remote-compaction
 * replay) owns the word message too and replaces both together. A sealed result passes its seal on
 * only while the result still matches it; the copy is then sealed with the word message's own
 * fingerprint, since it is rebuilt on every conversion and cannot keep a seal from an earlier one.
 */
function wordMessage(content: TextContent[], source: ToolResultMessage): Message {
	const message: Message = { role: "user", content, timestamp: source.timestamp };
	const provenance = getContextProvenance(source);
	if (!provenance) return message;
	const { integrity, ...owned } = provenance;
	const proven = integrity === undefined || integrity === contextProvenanceFingerprint(source);
	if (!proven) return message;
	const sealed = integrity === undefined ? owned : { ...owned, integrity: contextProvenanceFingerprint(message) };
	return Object.assign(message, { [CONTEXT_PROVENANCE_FIELD]: sealed });
}

/** Already converted output carries the word message right after the run; converting again keeps one. */
function startsWithBlocks(message: Message | undefined, blocks: readonly TextContent[]): boolean {
	if (message?.role !== "user" || typeof message.content === "string") return false;
	const content = message.content;
	return blocks.every((block, index) => {
		const candidate = content[index];
		return candidate?.type === "text" && candidate.text === block.text;
	});
}
