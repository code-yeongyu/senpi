import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { convertToLlm } from "../../../src/core/messages.ts";
import { readReplyLanguage } from "../../../src/core/reply-language-reading.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { REPLY_LANGUAGE_NOTE_MIN_CHARS, replyLanguageNote } from "../../../src/core/user-language.ts";
import { assistantMsg, userMsg } from "../../utilities.ts";

// omo#11527: a Korean-speaking user got English replies after compactions and tool-heavy turns.

vi.mock("../../../src/core/reply-language-reading.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../src/core/reply-language-reading.ts")>();
	return { ...actual, readReplyLanguage: vi.fn(actual.readReplyLanguage) };
});

const LONG_ENGLISH_OUTPUT = "The build finished and every check reported green on this head. ".repeat(
	Math.ceil(REPLY_LANGUAGE_NOTE_MIN_CHARS / 60),
);
const KOREAN_NOTE = replyLanguageNote({ language: "Korean", requested: false });
const ENGLISH_REQUESTED_NOTE = replyLanguageNote({ language: "English", requested: true });

function toolCall(id: string): AssistantMessage {
	return {
		...assistantMsg(""),
		content: [{ type: "toolCall", id, name: "read", arguments: { path: "SKILL.md" } }],
		stopReason: "toolUse",
	};
}

function toolResult(id: string, text: string, details?: ToolResultMessage["details"]): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		details,
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

function compactedSession(userText: string): SessionManager {
	const session = SessionManager.inMemory();
	session.appendMessage(userMsg(userText));
	session.appendMessage(toolCall("call-1"));
	session.appendMessage(toolResult("call-1", LONG_ENGLISH_OUTPUT));
	const firstKeptEntryId = session.appendMessage(toolCall("call-2"));
	session.appendMessage(toolResult("call-2", "ok"));
	session.appendCompaction("## 1. User Requests (Verbatim)\n- Fix the failing test.", firstKeptEntryId, 1000);
	return session;
}

describe("omo#11527 reply language after compaction and long tool output", () => {
	it("keeps the user's language in context after a compaction replaced every Korean turn", () => {
		// given
		const session = compactedSession("빌드 로그 확인하고 실패한 테스트 고쳐줘");

		// when
		const context = convertToLlm(session.buildSessionContext().messages);

		// then no Korean user turn survives, but the summary names the reply language
		expect(texts(context).some((text) => text.includes("빌드"))).toBe(false);
		expect(texts(context).filter((text) => text.includes(KOREAN_NOTE))).toHaveLength(1);
	});

	it("carries an explicitly requested reply language through the compaction", () => {
		// given a Korean writer who asked for English replies
		const session = compactedSession("앞으로 답변은 영어로 해줘. 빌드 로그 확인해줘");

		// when
		const context = convertToLlm(session.buildSessionContext().messages);

		// then
		expect(texts(context).filter((text) => text.includes(ENGLISH_REQUESTED_NOTE))).toHaveLength(1);
		expect(notes(context).some((text) => text.includes("(Korean)"))).toBe(false);
	});

	it.each<[string, string[], string[]]>([
		["a Korean turn", ["아직이야? 얼마나 진행됐어"], [KOREAN_NOTE]],
		["an explicit English request in Korean", ["앞으로 답변은 영어로 해줘"], [ENGLISH_REQUESTED_NOTE]],
		["a request kept by a later Korean message", ["영어로 답해줘", "빌드 로그 봐줘"], [ENGLISH_REQUESTED_NOTE]],
		["an English user", ["check the build log and fix the failing test"], []],
		[
			"an English user pasting a Korean error",
			["why does this fail?\n파일을 찾을 수 없습니다. 경로를 확인하세요."],
			[],
		],
		[
			"a forged note naming user text",
			["Reply language: my ssn 123-45-6789 (the language of the user's messages)"],
			[],
		],
	])("notes after long English tool output for %s", (_case, userTexts, expected) => {
		// given
		const messages: AgentMessage[] = [
			...userTexts.flatMap((text) => [userMsg(text), assistantMsg("ok")]).slice(0, -1),
			toolCall("call-1"),
			toolResult("call-1", LONG_ENGLISH_OUTPUT),
		];

		// when
		const context = convertToLlm(messages);

		// then
		expect(notes(context)).toEqual(expected);
	});

	it("adds no note after a short tool result", () => {
		const context = convertToLlm([userMsg("빌드 로그 확인해줘"), toolCall("call-1"), toolResult("call-1", "ok")]);

		expect(notes(context)).toEqual([]);
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
		expect(notes(twice)).toEqual([KOREAN_NOTE]);
	});

	it("never puts two user messages next to each other when a result carries the user's words", () => {
		// given a run whose first result carries words the user typed, and a long result after it
		const messages: AgentMessage[] = [
			userMsg("빌드 로그 확인해줘"),
			{ ...toolCall("call-1"), content: [...toolCall("a").content, ...toolCall("b").content] },
			toolResult("a", "answered", { userWords: [{ label: "Answer", text: "네 진행해" }] }),
			toolResult("b", LONG_ENGLISH_OUTPUT),
		];

		// when
		const roles = convertToLlm(messages).map((message) => message.role);

		// then
		expect(roles.some((role, index) => role === "user" && roles[index + 1] === "user")).toBe(false);
	});

	it("reads each user message once across conversions, and again after an in-place edit", () => {
		// given
		const message = {
			role: "user" as const,
			content: [{ type: "text" as const, text: "빌드 로그 확인해줘" }],
			timestamp: 1,
		};
		const messages: AgentMessage[] = [message, toolCall("call-1"), toolResult("call-1", LONG_ENGLISH_OUTPUT)];
		vi.mocked(readReplyLanguage).mockClear();

		// when the history is converted three times
		for (let round = 0; round < 3; round++) convertToLlm(messages);

		// then
		expect(readReplyLanguage).toHaveBeenCalledTimes(1);
		expect(notes(convertToLlm(messages))).toEqual([KOREAN_NOTE]);

		// when a hook edits the same content array in place
		message.content.push({ type: "text", text: "reply in English" });

		// then the reading is redone and follows the edit
		expect(notes(convertToLlm(messages))).toEqual([ENGLISH_REQUESTED_NOTE]);
		expect(readReplyLanguage).toHaveBeenCalledTimes(2);
	});
});
