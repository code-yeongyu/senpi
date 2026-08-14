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

const model = { api: "faux", provider: "faux", id: "faux-model" } as const;

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
	it("preserves user and assistant roles for each history pair", () => {
		const entries = [historyEntry(1), historyEntry(2)];

		expect(buildBtwHistoryMessages(entries, model)).toEqual([
			{ role: "user", content: "Earlier side question: question 1", timestamp: 1 },
			{
				role: "assistant",
				content: [{ type: "text", text: "Your earlier answer: answer 1" }],
				api: "faux",
				provider: "faux",
				model: "faux-model",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1,
			},
			{ role: "user", content: "Earlier side question: question 2", timestamp: 2 },
			expect.objectContaining({
				role: "assistant",
				content: [{ type: "text", text: "Your earlier answer: answer 2" }],
				timestamp: 2,
			}),
		]);
	});

	it("uses the newest ten entries by default", () => {
		const entries = Array.from({ length: 12 }, (_, index) => historyEntry(index + 1));

		const messages = buildBtwHistoryMessages(entries, model);

		expect(messages).toHaveLength(BTW_HISTORY_CONTEXT_LIMIT * 2);
		expect(messages[0]).toEqual({ role: "user", content: "Earlier side question: question 3", timestamp: 3 });
		expect(messages[1]).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Your earlier answer: answer 3" }],
		});
		expect(messages.at(-2)).toEqual({ role: "user", content: "Earlier side question: question 12", timestamp: 12 });
		expect(messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "Your earlier answer: answer 12" }],
		});
	});
});
