import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages.js";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildPromptBlocks,
	CONVERSATION_HISTORY_CLOSER,
} from "../src/core/extensions/builtin/anthropic-subscription/prompt-bridge.ts";
import { dedupeUltraworkBlocks } from "../src/core/extensions/builtin/anthropic-subscription/prompt-directive-dedupe.ts";

const OPEN = "<ultrawork-mode>";
const CLOSE = "</ultrawork-mode>";
const BODY = "x".repeat(100);

function assistantMessage(content: AssistantMessage["content"], timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "claude-sdk-oauth",
		provider: "anthropic-subscription",
		model: "claude-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function userMsg(content: string, timestamp: number): { role: "user"; content: string; timestamp: number } {
	return { role: "user", content, timestamp };
}

function blocksToText(blocks: ReadonlyArray<{ type: string; text?: string }>): string {
	return blocks.map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : "")).join("");
}

function countDirectiveSpans(text: string): number {
	const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`${escaped(OPEN)}[\\s\\S]*?${escaped(CLOSE)}`, "g");
	return (text.match(re) ?? []).length;
}

describe("Claude SDK OAuth prompt directive dedupe", () => {
	it("keeps the first history copy and the current message's copy, collapsing repeats in between", () => {
		const context: Context = {
			messages: [
				userMsg(`${OPEN}${BODY}${CLOSE}`, 1),
				assistantMessage([{ type: "text", text: "ok" }], 2),
				userMsg(`${OPEN}${BODY}${CLOSE}`, 3),
				assistantMessage([{ type: "text", text: "ok2" }], 4),
				userMsg(`${OPEN}${BODY}${CLOSE}`, 5),
			],
		};
		const { blocks, collapsedDirectives } = dedupeUltraworkBlocks(buildPromptBlocks(context));
		const full = blocksToText(blocks);
		expect(countDirectiveSpans(full)).toBe(2);
		expect((full.match(/ultrawork directive repeated/g) ?? []).length).toBe(1);
		expect(collapsedDirectives).toBe(1);
	});

	it("keeps surrounding user text intact when collapsing a directive span", () => {
		const context: Context = {
			messages: [
				userMsg(`${OPEN}${BODY}${CLOSE}`, 1),
				userMsg(`do X\n${OPEN}${BODY}${CLOSE}`, 2),
				userMsg("current", 3),
			],
		};
		const { blocks } = dedupeUltraworkBlocks(buildPromptBlocks(context));
		const full = blocksToText(blocks);
		expect(full).toContain("do X");
		expect((full.match(/ultrawork directive repeated/g) ?? []).length).toBe(1);
	});

	it("returns blocks byte-identical when no directive spans are present", () => {
		const context: Context = {
			messages: [
				{ role: "user", content: "Find it", timestamp: 1 },
				assistantMessage([{ type: "text", text: "ok" }], 2),
				{ role: "user", content: "Explain", timestamp: 3 },
			],
		};
		const baseline = buildPromptBlocks(context);
		const { blocks, collapsedDirectives } = dedupeUltraworkBlocks(baseline);
		expect(blocks).toEqual(baseline);
		expect(collapsedDirectives).toBe(0);
	});

	it("leaves an unmatched open tag untouched", () => {
		const context: Context = { messages: [userMsg(`lone ${OPEN} mention`, 1)] };
		const { blocks, collapsedDirectives } = dedupeUltraworkBlocks(buildPromptBlocks(context));
		expect(collapsedDirectives).toBe(0);
		expect(blocksToText(blocks)).toContain(OPEN);
	});

	it("preserves the only directive copy when it is the final user message", () => {
		const context: Context = {
			messages: [
				userMsg("earlier turn", 1),
				assistantMessage([{ type: "text", text: "ok" }], 2),
				userMsg(`${OPEN}${BODY}${CLOSE}`, 3),
			],
		};
		const { blocks, collapsedDirectives } = dedupeUltraworkBlocks(buildPromptBlocks(context));
		expect(collapsedDirectives).toBe(0);
		expect(countDirectiveSpans(blocksToText(blocks))).toBe(1);
	});

	it("keeps distinct directives intact; only identical repeats collapse", () => {
		const first = "FIRST-BODY-SENTINEL";
		const second = "SECOND-BODY-SENTINEL";
		const last = "LAST-BODY-SENTINEL";
		const context: Context = {
			messages: [
				userMsg(`${OPEN}${first}${CLOSE}`, 1),
				assistantMessage([{ type: "text", text: "ok" }], 2),
				userMsg(`${OPEN}${second}${CLOSE}`, 3),
				assistantMessage([{ type: "text", text: "ok2" }], 4),
				userMsg(`${OPEN}${last}${CLOSE}`, 5),
			],
		};
		const { blocks, collapsedDirectives } = dedupeUltraworkBlocks(buildPromptBlocks(context));
		const full = blocksToText(blocks);

		expect(collapsedDirectives).toBe(0);
		expect(full).toContain(last);
		expect(full).toContain(first);
		expect(full).toContain(second);
	});

	it("fails closed when nesting is split across separate text blocks", () => {
		const blocks: ContentBlockParam[] = [
			{ type: "text", text: `${OPEN}PRIOR-FLAT${CLOSE}` },
			{ type: "text", text: `${OPEN}outer ` },
			{ type: "text", text: `${OPEN}inner${CLOSE}` },
			{ type: "text", text: ` tail${CLOSE}` },
		];
		const { blocks: out, collapsedDirectives } = dedupeUltraworkBlocks(blocks);
		const full = blocksToText(out);

		expect(collapsedDirectives).toBe(0);
		expect(full).toContain("PRIOR-FLAT");
		expect((full.match(/ultrawork directive repeated/g) ?? []).length).toBe(0);
	});

	it("still collapses flat directives that merely span separate blocks", () => {
		const blocks: ContentBlockParam[] = [
			{ type: "text", text: `${OPEN}FLAT${CLOSE}` },
			{ type: "text", text: "interleaved prose" },
			{ type: "text", text: `${OPEN}FLAT${CLOSE}` },
			{ type: "text", text: CONVERSATION_HISTORY_CLOSER },
			{ type: "text", text: `${OPEN}FLAT${CLOSE}` },
		];
		const { blocks: out, collapsedDirectives } = dedupeUltraworkBlocks(blocks);

		expect(collapsedDirectives).toBe(1);
		expect(countDirectiveSpans(blocksToText(out))).toBe(2);
		expect(blocksToText(out.slice(2, 3))).toContain("ultrawork directive repeated");
	});

	it("collapses nothing without a replayed history", () => {
		const blocks: ContentBlockParam[] = [
			{ type: "text", text: `${OPEN}FLAT${CLOSE}` },
			{ type: "text", text: `${OPEN}FLAT${CLOSE}` },
		];
		expect(dedupeUltraworkBlocks(blocks).collapsedDirectives).toBe(0);
	});

	it("leaves nested directive tags untouched, failing closed rather than corrupting them", () => {
		const nested = `${OPEN}outer ${OPEN}inner${CLOSE} tail${CLOSE}`;
		const context: Context = {
			messages: [userMsg(`${OPEN}${BODY}${CLOSE}`, 1), userMsg(nested, 2)],
		};
		const { blocks, collapsedDirectives } = dedupeUltraworkBlocks(buildPromptBlocks(context));
		const full = blocksToText(blocks);

		expect(collapsedDirectives).toBe(0);
		expect(full).toContain(BODY);
		expect(full).toContain("inner");
		expect(full).toContain("tail");
		expect((full.match(/ultrawork directive repeated/g) ?? []).length).toBe(0);
	});

	it("also collapses a directive copy echoed in an assistant message (superset of user-only)", () => {
		const context: Context = {
			messages: [
				userMsg(`${OPEN}${BODY}${CLOSE}`, 1),
				assistantMessage([{ type: "text", text: `echo ${OPEN}${BODY}${CLOSE}` }], 2),
				userMsg(`${OPEN}${BODY}${CLOSE}`, 3),
			],
		};
		const { blocks, collapsedDirectives } = dedupeUltraworkBlocks(buildPromptBlocks(context));
		expect(collapsedDirectives).toBe(1);
		expect(countDirectiveSpans(blocksToText(blocks))).toBe(2);
	});
});
