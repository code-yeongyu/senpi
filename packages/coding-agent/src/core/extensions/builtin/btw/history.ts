import type { Message } from "@earendil-works/pi-ai/compat";
import type { SessionEntry } from "../../../session-manager.ts";

export const BTW_HISTORY_ENTRY_TYPE = "btw-history";
export const BTW_HISTORY_CONTEXT_LIMIT = 10;

export interface BtwHistoryEntry {
	readonly question: string;
	readonly answer: string;
	readonly timestamp: number;
}

type AssistantMessage = Extract<Message, { role: "assistant" }>;

interface BtwHistoryModel {
	readonly api: AssistantMessage["api"];
	readonly provider: AssistantMessage["provider"];
	readonly id: string;
}

const EMPTY_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

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
	model: BtwHistoryModel,
	limit = BTW_HISTORY_CONTEXT_LIMIT,
): Message[] {
	const boundedLimit = Math.max(0, limit);
	return entries.slice(Math.max(entries.length - boundedLimit, 0)).flatMap((entry): Message[] => [
		{ role: "user", content: `Earlier side question: ${entry.question}`, timestamp: entry.timestamp },
		{
			role: "assistant",
			content: [{ type: "text", text: `Your earlier answer: ${entry.answer}` }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: EMPTY_USAGE,
			stopReason: "stop",
			timestamp: entry.timestamp,
		},
	]);
}
