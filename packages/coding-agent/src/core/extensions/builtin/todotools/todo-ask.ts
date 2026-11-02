import type { SessionEntry } from "../../../session-manager.ts";
import { parseAskUserAnswerFrame } from "../ask-user/format.ts";
import { sanitizeTodoText } from "./todo-format.ts";
import { isTodoAsk } from "./todo-storage.ts";
import { TODO_RESTORE_REQUEST_TYPE, TODO_STATE_ENTRY_TYPE, type TodoAsk } from "./todo-types.ts";

export const ASK_TEXT_LIMIT = 200;

export function firstTextBlock(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	for (const block of content) {
		if (typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string") {
			return block.text;
		}
	}
	return undefined;
}

export function truncateAskText(text: string): string {
	const codePoints = Array.from(text);
	if (codePoints.length <= ASK_TEXT_LIMIT) return text;
	return `${codePoints.slice(0, ASK_TEXT_LIMIT).join("")}… (+${codePoints.length - ASK_TEXT_LIMIT} chars)`;
}

/**
 * The ask a newly created list anchors to. The first list of a branch anchors to the
 * session's first user request; a later list-creating call is an explicit redirect and
 * anchors to the newest user request. Ask-user answer frames are replies, not requests.
 * A compaction restore request newer than both the last list and the last user request
 * re-emits the ask its snapshot carried; the model never supplies an ask itself.
 */
export function captureListAsk(entries: readonly SessionEntry[], capturedAt: number): TodoAsk | undefined {
	let lastStateIndex = -1;
	let restore: { index: number; ask: TodoAsk } | undefined;
	const requests: Array<{ index: number; entryId: string; text: string }> = [];

	entries.forEach((entry, index) => {
		if (entry.type === "custom" && entry.customType === TODO_STATE_ENTRY_TYPE) {
			lastStateIndex = index;
			return;
		}
		if (entry.type === "custom_message" && entry.customType === TODO_RESTORE_REQUEST_TYPE) {
			const ask = (entry.details as { ask?: unknown } | undefined)?.ask;
			if (isTodoAsk(ask)) restore = { index, ask };
			return;
		}
		if (entry.type !== "message" || entry.message.role !== "user") return;
		const raw = firstTextBlock(entry.message.content);
		if (raw === undefined || parseAskUserAnswerFrame(raw)) return;
		const text = sanitizeTodoText(raw);
		if (text) requests.push({ index, entryId: entry.id, text });
	});

	const latest = requests.at(-1);
	if (restore && restore.index > lastStateIndex && restore.index > (latest?.index ?? -1)) return { ...restore.ask };
	const chosen = lastStateIndex === -1 ? requests[0] : latest;
	return chosen ? { entryId: chosen.entryId, text: truncateAskText(chosen.text), capturedAt } : undefined;
}
