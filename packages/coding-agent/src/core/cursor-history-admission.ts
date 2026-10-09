/**
 * Cursor request admission: what the transport is allowed to send in one turn.
 *
 * Cursor rebuilds the whole conversation on every hop and rejects large
 * verbatim tool payloads, so a turn is bounded twice - each tool result is
 * capped on its own, and the aggregate model input is held under the model's
 * context window. Admission NEVER deletes a turn (senpi#1603): dropping the
 * oldest turns to reach a byte cap silently amputated the conversation, and a
 * history that still exceeds the budget after blanking is admitted as-is so the
 * existing Cursor overflow path (a 0-token `resource_exhausted` surfaced to the
 * session layer) compacts it with the session's own policy.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { measureCursorModelInputSerializedBytes } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai/compat";
import { convertToLlm } from "./messages.ts";

/** Cursor ingest rejects large verbatim tool payloads. The bound is graphemes. */
export const CURSOR_TOOL_RESULT_MAX_CHARS = 2000;
const CURSOR_TRUNCATION_MARKER = "\n...[truncated]";
/** Repo-wide estimate, matching `estimateTokens` in core/compaction. */
const CHARS_PER_TOKEN = 4;

/** Aggregate admission budget for a model whose window is `contextWindowTokens`. */
export function cursorAdmissionBudgetBytes(contextWindowTokens: number): number {
	if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) return 0;
	return Math.floor(contextWindowTokens) * CHARS_PER_TOKEN;
}

export type CursorAdmissionRequest = {
	readonly messages: AgentMessage[] | undefined;
	/** Serialized model-input bytes this turn may occupy. */
	readonly budgetBytes: number;
	readonly maxChars?: number;
	readonly convert?: (candidate: AgentMessage[]) => Message[];
};

export type CursorAdmissionResult = {
	readonly messages: AgentMessage[] | undefined;
	readonly changed: boolean;
	readonly blankedToolResults: number;
	readonly bytesBefore: number;
	readonly bytesAfter: number;
	/** True when the history still exceeds the budget; the request is still sent. */
	readonly overBudget: boolean;
};

function capToolResultBodies(
	messages: AgentMessage[],
	maxChars: number,
): { readonly messages: AgentMessage[]; readonly changed: boolean } {
	const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	const markerChars = [...segmenter.segment(CURSOR_TRUNCATION_MARKER)].length;
	const result = messages.slice();
	let changed = false;
	for (let messageIndex = result.length - 1; messageIndex >= 0; messageIndex--) {
		const message = result[messageIndex];
		if (message.role !== "toolResult" || !Array.isArray(message.content)) continue;
		let content = message.content;
		for (let partIndex = content.length - 1; partIndex >= 0; partIndex--) {
			const part = content[partIndex];
			if (part.type === "image" && typeof part.data === "string") continue;
			if (part.type !== "text" || typeof part.text !== "string") continue;
			const graphemes = [...segmenter.segment(part.text)].map((item) => item.segment);
			if (graphemes.length <= maxChars) continue;
			const kept = graphemes.slice(0, Math.max(0, maxChars - markerChars)).join("");
			content = content === message.content ? content.slice() : content;
			content[partIndex] = { ...part, text: kept + CURSOR_TRUNCATION_MARKER };
			result[messageIndex] = { ...message, content };
			changed = true;
		}
	}
	return { messages: result, changed };
}

function emptyToolResult(message: AgentMessage): AgentMessage {
	if (message.role !== "toolResult" || !Array.isArray(message.content)) return message;
	const emptiedContent = message.content.map((part) =>
		part.type === "text" ? { ...part, text: "" } : part.type === "image" ? { ...part, data: "" } : part,
	);
	const content = emptiedContent.filter((part, index) => {
		if (index === 0) return true;
		const previous = emptiedContent[index - 1];
		const empty = part.type === "text" ? part.text === "" : part.type === "image" && part.data === "";
		const previousEmpty =
			previous.type === "text" ? previous.text === "" : previous.type === "image" && previous.data === "";
		return !empty || !previousEmpty;
	});
	return { ...message, content };
}

/**
 * Empties the oldest result bodies until the rest fits. The prefix search is
 * monotonic, so admission stays bounded instead of reserializing the whole
 * history once per tool result.
 */
function blankOldestToolResults(
	messages: AgentMessage[],
	fits: (candidate: AgentMessage[]) => boolean,
): { readonly messages: AgentMessage[]; readonly count: number } {
	const toolResultIndexes = messages.flatMap((message, index) =>
		message.role === "toolResult" && Array.isArray(message.content) ? [index] : [],
	);
	const withEmptyPrefix = (count: number): AgentMessage[] => {
		const candidate = messages.slice();
		for (let i = 0; i < count; i++)
			candidate[toolResultIndexes[i]] = emptyToolResult(candidate[toolResultIndexes[i]]);
		return candidate;
	};
	let low = 0;
	let high = toolResultIndexes.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (fits(withEmptyPrefix(middle + 1))) high = middle;
		else low = middle + 1;
	}
	const count = Math.min(low + 1, toolResultIndexes.length);
	return { messages: count > 0 ? withEmptyPrefix(count) : messages, count };
}

/**
 * Bounds one Cursor request: per-result caps first, then blanking the oldest
 * tool result bodies while the model input exceeds `budgetBytes`. Conversation
 * turns are never removed.
 */
export function admitCursorHistory(request: CursorAdmissionRequest): CursorAdmissionResult {
	const { messages, budgetBytes } = request;
	if (!Array.isArray(messages) || messages.length === 0) {
		return { messages, changed: false, blankedToolResults: 0, bytesBefore: 0, bytesAfter: 0, overBudget: false };
	}
	const convert = request.convert ?? ((candidate: AgentMessage[]) => convertToLlm(candidate));
	const capped = capToolResultBodies(messages, request.maxChars ?? CURSOR_TOOL_RESULT_MAX_CHARS);
	const measure = (candidate: AgentMessage[]): number => {
		const converted = convert(candidate);
		const activeUserMessageIndex = converted.at(-1)?.role === "user" ? converted.length - 1 : -1;
		return measureCursorModelInputSerializedBytes(converted, activeUserMessageIndex);
	};

	const bytesBefore = measure(capped.messages);
	if (bytesBefore <= budgetBytes) {
		return {
			messages: capped.changed ? capped.messages : messages,
			changed: capped.changed,
			blankedToolResults: 0,
			bytesBefore,
			bytesAfter: bytesBefore,
			overBudget: false,
		};
	}

	const blanked = blankOldestToolResults(capped.messages, (candidate) => measure(candidate) <= budgetBytes);
	const bytesAfter = blanked.count > 0 ? measure(blanked.messages) : bytesBefore;
	const changed = capped.changed || blanked.count > 0;
	return {
		messages: changed ? blanked.messages : messages,
		changed,
		blankedToolResults: blanked.count,
		bytesBefore,
		bytesAfter,
		overBudget: bytesAfter > budgetBytes,
	};
}

/**
 * Positional entry point kept for existing callers. An omitted `maxBytes`
 * applies the per-result cap only; the aggregate budget belongs to the caller
 * that knows the model window.
 */
export function truncateToolResultBodies(
	messages: AgentMessage[] | undefined,
	maxChars = CURSOR_TOOL_RESULT_MAX_CHARS,
	maxBytes = Number.POSITIVE_INFINITY,
	convert = (candidate: AgentMessage[]) => convertToLlm(candidate),
): { messages: AgentMessage[] | undefined; changed: boolean } {
	const admission = admitCursorHistory({ messages, budgetBytes: maxBytes, maxChars, convert });
	return { messages: admission.messages, changed: admission.changed };
}
