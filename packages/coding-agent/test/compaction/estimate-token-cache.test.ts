import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { markTransientMessage } from "../../src/core/compaction/estimate-cache-key.ts";
import { estimateTokens } from "../../src/core/compaction/index.ts";
import { estimateTotalTokens } from "../../src/core/extensions/builtin/compaction/overflow-retry.ts";
import { ResidentStringStore } from "../../src/core/session-resident-store.ts";

function textMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function prose(chars: number): string {
	return "lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(Math.ceil(chars / 57)).slice(0, chars);
}

function firstBlock(message: AgentMessage): { text: string } {
	if (message.role !== "user" || typeof message.content === "string") throw new Error("expected block content");
	const block = message.content[0];
	if (block?.type !== "text") throw new Error("expected a text block");
	return block;
}

function cjk(chars: number): string {
	return "\u6f22\u5b57".repeat(Math.ceil(chars / 2)).slice(0, chars);
}

describe("per-message token estimate cache (senpi#2525)", () => {
	it("returns the same estimate for an unchanged message, and for a fresh equal copy", () => {
		const message = fauxAssistantMessage(
			[fauxToolCall("read", { path: "/src/a.ts", content: prose(400) }, { id: "call-1" })],
			{ stopReason: "toolUse" },
		);

		const first = estimateTokens(message);

		expect(estimateTokens(message)).toBe(first);
		expect(estimateTokens(structuredClone(message))).toBe(first);
		expect(estimateTotalTokens([message])).toBe(estimateTotalTokens([message]));
	});

	it("re-estimates when a block's text is swapped in place for a different length", () => {
		const message = textMessage(prose(4000));
		expect(estimateTokens(message)).toBe(1000);

		firstBlock(message).text = prose(1000);

		expect(estimateTokens(message)).toBe(250);
	});

	it("re-estimates a same-length swap whose first and last characters match (review M2)", () => {
		const plain = `a${"x ".repeat(511)}b`;
		const base64Run = `a${"QUJD".repeat(255)}ABb`;
		expect(base64Run.length).toBe(plain.length);
		const message = textMessage(plain);
		const plainEstimate = estimateTokens(message);

		firstBlock(message).text = base64Run;

		expect(estimateTokens(message)).toBe(estimateTokens(textMessage(base64Run)));
		expect(estimateTokens(message)).not.toBe(plainEstimate);
	});

	it("re-estimates when a numeric tool argument changes in place (review M2)", () => {
		const message = fauxAssistantMessage([fauxToolCall("read", { path: "/a", offset: 7 }, { id: "call-n" })], {
			stopReason: "toolUse",
		});
		estimateTokens(message);
		const call = message.content[0];
		if (call?.type !== "toolCall") throw new Error("expected a tool call");

		call.arguments = { ...call.arguments, offset: 7_000_000_000 };

		expect(estimateTokens(message)).toBe(estimateTokens(structuredClone(message)));
	});

	it("the wire estimate re-estimates after an in-place change (review M3)", () => {
		const message = textMessage(prose(4000));
		const before = estimateTotalTokens([message]);

		firstBlock(message).text = cjk(4000);

		expect(estimateTotalTokens([message])).toBe(estimateTotalTokens([textMessage(cjk(4000))]));
		expect(estimateTotalTokens([message])).toBeGreaterThan(before);
	});

	it("estimates correctly after tokenize and materialize swap strings in place", () => {
		const store = new ResidentStringStore();
		const message = textMessage(prose(40_000));
		const baseline = estimateTokens(message);
		expect(baseline).toBe(10_000);

		store.externalizeInPlace(message);
		const tokenized = estimateTokens(message);
		expect(tokenized).toBeLessThan(baseline);

		store.materializeInPlace(message);
		expect(estimateTokens(message)).toBe(baseline);
	});

	it("estimates a per-turn clone correctly, including after an in-place change (the uncached M1 path)", () => {
		const message = markTransientMessage(textMessage(prose(4000)));
		expect(estimateTokens(message)).toBe(1000);
		expect(estimateTotalTokens([message])).toBe(1000);

		firstBlock(message).text = prose(2000);

		expect(estimateTokens(message)).toBe(500);
		expect(estimateTotalTokens([message])).toBe(500);
	});
});
