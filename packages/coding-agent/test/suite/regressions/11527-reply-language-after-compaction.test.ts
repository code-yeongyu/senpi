import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { convertToLlm } from "../../../src/core/messages.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import {
	type ReplyLanguageReading,
	readReplyLanguage,
	REPLY_LANGUAGE_NOTE_MIN_CHARS,
	replyLanguageNote,
} from "../../../src/core/user-language.ts";
import { assistantMsg, userMsg } from "../../utilities.ts";

// omo#11527: a Korean-speaking user got English replies after compactions and tool-heavy turns.

const LONG_ENGLISH_OUTPUT = "The build finished and every check reported green on this head. ".repeat(
	Math.ceil(REPLY_LANGUAGE_NOTE_MIN_CHARS / 60),
);

function toolCall(id: string): AssistantMessage {
	return {
		...assistantMsg(""),
		content: [{ type: "toolCall", id, name: "read", arguments: { path: "SKILL.md" } }],
		stopReason: "toolUse",
	};
}

function toolResult(id: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function texts(messages: Message[]): string[] {
	return messages.flatMap((message) =>
		message.role === "user" && typeof message.content !== "string"
			? message.content.flatMap((block) => (block.type === "text" ? [block.text] : []))
			: [],
	);
}

function notes(messages: Message[]): string[] {
	return texts(messages).filter((text) => text.includes("Reply language:"));
}

describe("omo#11527 reply language after compaction and long tool output", () => {
	it("keeps the user's language in context after a compaction replaced every Korean turn", () => {
		// given a Korean session compacted in the middle of a tool-heavy turn
		const session = SessionManager.inMemory();
		session.appendMessage(userMsg("빌드 로그 확인하고 실패한 테스트 고쳐줘"));
		session.appendMessage(toolCall("call-1"));
		session.appendMessage(toolResult("call-1", LONG_ENGLISH_OUTPUT));
		const firstKeptEntryId = session.appendMessage(toolCall("call-2"));
		session.appendMessage(toolResult("call-2", "ok"));
		session.appendCompaction(
			"## 1. User Requests (Verbatim)\n- Fix the failing test from the build log.",
			firstKeptEntryId,
			1000,
		);

		// when
		const context = convertToLlm(session.buildSessionContext().messages);

		// then no Korean user turn survives, but the next request still names the reply language
		expect(texts(context).some((text) => text.includes("빌드"))).toBe(false);
		expect(texts(context).filter((text) => text.includes(replyLanguageNote("Korean")))).toHaveLength(1);
	});

	it("adds a note after long English tool output in a Korean turn, before the next reply", () => {
		// given
		const messages: AgentMessage[] = [
			userMsg("아직이야? 얼마나 진행됐어"),
			toolCall("call-1"),
			toolResult("call-1", LONG_ENGLISH_OUTPUT),
		];

		// when
		const context = convertToLlm(messages);

		// then
		expect(notes(context)).toEqual([replyLanguageNote("Korean")]);
		expect(context.at(-1)).toMatchObject({ role: "user" });
	});

	it("keeps every earlier request byte-identical as the turn grows", () => {
		// given
		const messages: AgentMessage[] = [
			userMsg("20번은 화질이 넘 작던데"),
			toolCall("call-1"),
			toolResult("call-1", LONG_ENGLISH_OUTPUT),
		];
		const first = convertToLlm(messages);

		// when the reply and another tool call extend the same history
		const second = convertToLlm([...messages, toolCall("call-2"), toolResult("call-2", "ok")]);

		// then
		expect(second.slice(0, first.length)).toEqual(first);
	});

	it.each([
		["an English user", "check the build log and fix the failing test"],
		["a short tool result", "빌드 로그 확인해줘"],
	])("adds no note for %s", (_case, userText) => {
		// given
		const output = userText.startsWith("check") ? LONG_ENGLISH_OUTPUT : "ok";
		const messages: AgentMessage[] = [userMsg(userText), toolCall("call-1"), toolResult("call-1", output)];

		// when
		const context = convertToLlm(messages);

		// then
		expect(notes(context)).toEqual([]);
	});

	it("adds one note when converted output is converted again", () => {
		// given
		const messages: AgentMessage[] = [
			userMsg("고쳐줘"),
			toolCall("call-1"),
			toolResult("call-1", LONG_ENGLISH_OUTPUT),
		];

		// when
		const twice = convertToLlm(convertToLlm(messages));

		// then
		expect(notes(twice)).toHaveLength(1);
	});

	it.each<[string, ReplyLanguageReading]>([
		["아직이야? 얼마나 진행됐어", { kind: "language", language: "Korean" }],
		["PR #123 리뷰해줘 bundle-inputs check도 돌려", { kind: "language", language: "Korean" }],
		[
			"<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>\n고쳐줘",
			{ kind: "language", language: "Korean" },
		],
		["このテストを直してください", { kind: "language", language: "Japanese" }],
		["帮我看一下这个测试为什么失败", { kind: "language", language: "Chinese" }],
		["Почини этот тест, пожалуйста", { kind: "language", language: "Cyrillic script" }],
		["please translate 안녕 into English for the greeting screen", { kind: "latin" }],
		["corrige ce test s'il te plaît", { kind: "latin" }],
		["```\n빌드 실패\n```", { kind: "none" }],
	])("reads %j as %j", (text, expected) => {
		expect(readReplyLanguage(text)).toEqual(expected);
	});
});
