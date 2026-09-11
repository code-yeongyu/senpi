import { describe, expect, it } from "vitest";
import {
	measureCursorHistorySerializedBytes,
	measureCursorModelInputSerializedBytes,
} from "../src/api/cursor-agent/measure.ts";
import { buildCursorHistoryForTest } from "../src/api/cursor-agent.ts";
import type { AssistantMessage, Message } from "../src/types.ts";

function userText(content: string): Message {
	return { role: "user", content, timestamp: 0 };
}

function assistantText(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "cursor-agent",
		provider: "cursor",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

/** Three completed turns plus the active user message; every turn has substantial text. */
const HISTORY: Message[] = [
	userText("first question ".repeat(200)),
	assistantText("first answer ".repeat(200)),
	userText("second question ".repeat(200)),
	assistantText("second answer ".repeat(200)),
	userText("third question ".repeat(200)),
	assistantText("third answer ".repeat(200)),
	userText("active question"),
];

describe("measureCursorModelInputSerializedBytes", () => {
	it("excludes the turns[] display copies that inflate the full-wire measurement", () => {
		const modelInput = measureCursorModelInputSerializedBytes(HISTORY);
		const fullWire = measureCursorHistorySerializedBytes(HISTORY);

		expect(modelInput).toBeGreaterThan(0);
		expect(modelInput).toBeLessThan(fullWire);
		// turns[] re-encodes the same history, so the duplication is large, not incidental.
		expect(fullWire).toBeGreaterThan(modelInput * 1.5);
	});

	it("counts exactly the serialized rootPromptMessagesJson blobs and nothing else", () => {
		const expected = buildCursorHistoryForTest(HISTORY).rootPromptMessagesJson.reduce(
			(total: number, entry) => total + new TextEncoder().encode(JSON.stringify(entry)).byteLength,
			0,
		);

		expect(measureCursorModelInputSerializedBytes(HISTORY)).toBe(expected);
	});

	it("grows when the conversation gains a real turn", () => {
		const oneTurn: Message[] = [userText("first question"), assistantText("first answer"), userText("active")];
		const twoTurns: Message[] = [
			userText("first question"),
			assistantText("first answer"),
			userText("second question"),
			assistantText("second answer"),
			userText("active"),
		];

		const before = measureCursorModelInputSerializedBytes(oneTurn);
		const after = measureCursorModelInputSerializedBytes(twoTurns);
		expect(after).toBeGreaterThan(before);
		const encoding = new TextEncoder();
		expect(after - before).toBe(
			encoding.encode(JSON.stringify({ role: "user", content: [{ type: "text", text: "second question" }] }))
				.byteLength +
				encoding.encode(JSON.stringify({ role: "assistant", content: [{ type: "text", text: "second answer" }] }))
					.byteLength,
		);
	});

	it("keeps a ~102.5k-token history inside an 800,000-byte model-input budget the full wire exceeds", () => {
		// 410,000 characters is ~102,500 tokens under the repo-wide 4-chars-per-token
		// estimate, so the model input fits a 200k-token window (800,000 bytes). The
		// turns[] copies push the full-wire count past that same cap -- counting them
		// for model-input admission is what deleted the whole turn (issue #1603).
		const longText = "The quick brown fox jumps over the lazy dog. ".repeat(10_000).slice(0, 410_000);
		const messages: Message[] = [userText(longText), assistantText("Acknowledged."), userText("continue")];

		const modelInput = measureCursorModelInputSerializedBytes(messages);
		const fullWire = measureCursorHistorySerializedBytes(messages);

		expect(modelInput).toBeGreaterThan(400_000);
		expect(modelInput).toBeLessThan(800_000);
		expect(fullWire).toBeGreaterThan(800_000);
	});
});
