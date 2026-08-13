import type { Message } from "@earendil-works/pi-ai/compat";
import type { SessionEntry } from "../../../session-manager.ts";

export const BTW_HISTORY_ENTRY_TYPE = "btw-history";
export const BTW_HISTORY_CONTEXT_LIMIT = 10;

export interface BtwHistoryEntry {
	readonly question: string;
	readonly answer: string;
	readonly timestamp: number;
}

function isBtwHistoryEntry(data: unknown): data is BtwHistoryEntry {
	return (
		typeof data === "object" &&
		data !== null &&
		"question" in data &&
		typeof data.question === "string" &&
		"answer" in data &&
		typeof data.answer === "string" &&
		"timestamp" in data &&
		typeof data.timestamp === "number"
	);
}

export function readBtwHistory(entries: readonly SessionEntry[]): BtwHistoryEntry[] {
	const history: BtwHistoryEntry[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== BTW_HISTORY_ENTRY_TYPE) continue;
		if (isBtwHistoryEntry(entry.data)) history.push(entry.data);
	}
	return history;
}

export function buildBtwHistoryMessages(
	entries: readonly BtwHistoryEntry[],
	limit = BTW_HISTORY_CONTEXT_LIMIT,
): Message[] {
	const boundedLimit = Math.max(0, limit);
	return entries.slice(Math.max(entries.length - boundedLimit, 0)).map(
		(entry): Message => ({
			role: "user",
			content: `Earlier side question: ${entry.question}\nYour earlier answer: ${entry.answer}`,
			timestamp: entry.timestamp,
		}),
	);
}
