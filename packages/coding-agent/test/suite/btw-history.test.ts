import { describe, expect, it } from "vitest";
import {
	BTW_HISTORY_CONTEXT_LIMIT,
	BTW_HISTORY_ENTRY_TYPE,
	type BtwHistoryEntry,
	buildBtwHistoryMessages,
	readBtwHistory,
} from "../../src/core/extensions/builtin/btw/history.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";

function customEntry(customType: string, id: string, data: unknown): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: "root",
		timestamp: "2026-08-07T00:00:00.000Z",
		customType,
		data,
	};
}

function btwEntry(id: string, data: unknown): SessionEntry {
	return customEntry(BTW_HISTORY_ENTRY_TYPE, id, data);
}

function historyEntry(index: number): BtwHistoryEntry {
	return { question: `question ${index}`, answer: `answer ${index}`, timestamp: index };
}

function historyMessageContent(entry: BtwHistoryEntry): string {
	return `Earlier side question: ${entry.question}\nYour earlier answer: ${entry.answer}`;
}

describe("readBtwHistory", () => {
	it("returns valid btw custom entries oldest to newest while ignoring unrelated entries", () => {
		const entries: SessionEntry[] = [
			btwEntry("btw-1", { question: "first question", answer: "first answer", timestamp: 1 }),
			customEntry("foreign-history", "foreign-1", {
				question: "foreign question",
				answer: "foreign answer",
				timestamp: 2,
			}),
			btwEntry("btw-2", { question: "second question", answer: "second answer", timestamp: 3 }),
		];

		expect(readBtwHistory(entries)).toEqual([
			{ question: "first question", answer: "first answer", timestamp: 1 },
			{ question: "second question", answer: "second answer", timestamp: 3 },
		]);
	});

	it("skips malformed payloads without throwing", () => {
		const entries: SessionEntry[] = [
			btwEntry("missing-question", { answer: "answer only", timestamp: 1 }),
			btwEntry("non-string-answer", { question: "question only", answer: 42, timestamp: 2 }),
			btwEntry("valid", { question: "valid question", answer: "valid answer", timestamp: 3 }),
		];

		expect(() => readBtwHistory(entries)).not.toThrow();
		expect(readBtwHistory(entries)).toEqual([{ question: "valid question", answer: "valid answer", timestamp: 3 }]);
	});
});

describe("buildBtwHistoryMessages", () => {
	it("builds one user message per history pair", () => {
		const entries = [historyEntry(1), historyEntry(2)];

		expect(buildBtwHistoryMessages(entries)).toEqual([
			{ role: "user", content: historyMessageContent(entries[0]), timestamp: 1 },
			{ role: "user", content: historyMessageContent(entries[1]), timestamp: 2 },
		]);
	});

	it("uses the newest ten entries by default", () => {
		const entries = Array.from({ length: 12 }, (_, index) => historyEntry(index + 1));

		const messages = buildBtwHistoryMessages(entries);

		expect(messages).toHaveLength(BTW_HISTORY_CONTEXT_LIMIT);
		expect(messages[0]).toEqual({ role: "user", content: historyMessageContent(historyEntry(3)), timestamp: 3 });
		expect(messages.at(-1)).toEqual({
			role: "user",
			content: historyMessageContent(historyEntry(12)),
			timestamp: 12,
		});
	});
});
