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

function sessionInfoEntry(id: string): SessionEntry {
	return {
		type: "session_info",
		id,
		parentId: "root",
		timestamp: "2026-08-07T00:00:00.000Z",
		name: "session name",
	};
}

function historyEntry(index: number): BtwHistoryEntry {
	return {
		question: `question ${index}`,
		answer: `answer ${index}`,
		timestamp: index,
	};
}

function historyMessageContent(entry: BtwHistoryEntry): string {
	return `Earlier side question: ${entry.question}\nYour earlier answer: ${entry.answer}`;
}

describe("readBtwHistory", () => {
	it("returns valid btw custom entries oldest to newest while ignoring unrelated entries", () => {
		// Given mixed session entries with two valid btw history payloads in chronological branch order
		const entries: SessionEntry[] = [
			btwEntry("btw-1", { question: "first question", answer: "first answer", timestamp: 1 }),
			customEntry("foreign-history", "foreign-1", {
				question: "foreign question",
				answer: "foreign answer",
				timestamp: 2,
			}),
			sessionInfoEntry("session-info-1"),
			btwEntry("btw-2", { question: "second question", answer: "second answer", timestamp: 3 }),
		];

		// When btw history is read from the branch entries
		const history = readBtwHistory(entries);

		// Then only btw history entries remain and their input order is preserved
		expect(history).toEqual([
			{ question: "first question", answer: "first answer", timestamp: 1 },
			{ question: "second question", answer: "second answer", timestamp: 3 },
		]);
	});

	it("skips malformed payloads without throwing", () => {
		// Given malformed btw history payloads before a valid one
		const entries: SessionEntry[] = [
			btwEntry("missing-question", { answer: "answer only", timestamp: 1 }),
			btwEntry("non-string-answer", { question: "question only", answer: 42, timestamp: 2 }),
			btwEntry("valid", { question: "valid question", answer: "valid answer", timestamp: 3 }),
		];

		// When the branch scanner reads the entries
		const readHistory = () => readBtwHistory(entries);

		// Then malformed payloads are ignored and no exception escapes
		expect(readHistory).not.toThrow();
		expect(readHistory()).toEqual([{ question: "valid question", answer: "valid answer", timestamp: 3 }]);
	});
});

describe("buildBtwHistoryMessages", () => {
	it("returns an empty message list for empty input", () => {
		// Given no stored btw history
		const entries: BtwHistoryEntry[] = [];

		// When context messages are built
		const messages = buildBtwHistoryMessages(entries);

		// Then no messages are produced
		expect(messages).toEqual([]);
	});

	it("builds one user message per history pair", () => {
		// Given two stored btw history entries
		const firstEntry = historyEntry(1);
		const secondEntry = historyEntry(2);
		const entries = [firstEntry, secondEntry];

		// When the entries are converted to context messages
		const messages = buildBtwHistoryMessages(entries);

		// Then each message carries one question and its answer with the original timestamp
		expect(messages).toEqual([
			{ role: "user", content: historyMessageContent(firstEntry), timestamp: 1 },
			{ role: "user", content: historyMessageContent(secondEntry), timestamp: 2 },
		]);
		expect(messages[0]?.content).toContain("question 1");
		expect(messages[0]?.content).toContain("answer 1");
		expect(messages[1]?.content).toContain("question 2");
		expect(messages[1]?.content).toContain("answer 2");
	});

	it("uses the last ten entries by default", () => {
		// Given twelve stored btw history entries
		const entries = Array.from({ length: 12 }, (_, index) => historyEntry(index + 1));
		const firstKeptEntry = historyEntry(3);

		// When context messages are built without an explicit limit
		const messages = buildBtwHistoryMessages(entries);

		// Then exactly ten messages are retained and the first two entries are absent
		expect(messages).toHaveLength(BTW_HISTORY_CONTEXT_LIMIT);
		expect(messages[0]).toEqual({ role: "user", content: historyMessageContent(firstKeptEntry), timestamp: 3 });
		expect(messages[0]?.content).toContain("question 3");
		expect(messages[0]?.content).toContain("answer 3");
		expect(messages.some((message) => message.content === historyMessageContent(historyEntry(1)))).toBe(false);
		expect(messages.some((message) => message.content === historyMessageContent(historyEntry(2)))).toBe(false);
	});

	it("respects an explicit limit argument", () => {
		// Given three stored btw history entries
		const newestEntry = historyEntry(3);
		const entries = [historyEntry(1), historyEntry(2), newestEntry];

		// When one history pair is requested
		const messages = buildBtwHistoryMessages(entries, 1);

		// Then only the newest question and answer are included with the entry timestamp
		expect(messages).toEqual([{ role: "user", content: historyMessageContent(newestEntry), timestamp: 3 }]);
		expect(messages[0]?.content).toContain("question 3");
		expect(messages[0]?.content).toContain("answer 3");
	});
});
