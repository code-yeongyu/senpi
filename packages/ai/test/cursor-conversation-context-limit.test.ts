import { beforeEach, describe, expect, it } from "vitest";
import {
	forgetCursorConversationContextLimit,
	getCursorConversationContextLimit,
	recordCursorConversationContextLimit,
	setCursorActiveConversationWire,
} from "../src/cursor/conversation-context-limit.ts";

const SESSION = "session-under-test";
const BASE_CONVERSATION = "base-conversation";
const CONVERSATION_A = "conversation-a";
const CONVERSATION_B = "conversation-b";

describe("cursor conversation context limit", () => {
	beforeEach(() => {
		forgetCursorConversationContextLimit();
	});

	it("ignores the bootstrap checkpoint that reports no limit", () => {
		recordCursorConversationContextLimit(SESSION, CONVERSATION_A, 0);

		expect(getCursorConversationContextLimit(SESSION, CONVERSATION_A)).toBeUndefined();
		expect(getCursorConversationContextLimit(SESSION)).toBeUndefined();
	});

	it("records the limit the server reported", () => {
		recordCursorConversationContextLimit(SESSION, CONVERSATION_A, 200_000);

		expect(getCursorConversationContextLimit(SESSION, CONVERSATION_A)).toBe(200_000);
		expect(getCursorConversationContextLimit(SESSION)).toBe(200_000);
	});

	it("keeps the newest limit when the server revises it", () => {
		recordCursorConversationContextLimit(SESSION, CONVERSATION_A, 200_000);
		recordCursorConversationContextLimit(SESSION, CONVERSATION_A, 262_000);

		expect(getCursorConversationContextLimit(SESSION, CONVERSATION_A)).toBe(262_000);
	});

	it("keeps the live wire's limit reachable after Cursor rotates the wire id", () => {
		setCursorActiveConversationWire(SESSION, BASE_CONVERSATION, CONVERSATION_A);
		recordCursorConversationContextLimit(SESSION, CONVERSATION_A, 200_000);

		// Cursor rotates the wire id. The rotated wire has not reported yet, so its
		// budget stays unknown instead of inheriting the previous wire's limit.
		setCursorActiveConversationWire(SESSION, BASE_CONVERSATION, CONVERSATION_B);
		expect(getCursorConversationContextLimit(SESSION, BASE_CONVERSATION)).toBeUndefined();

		// Its own checkpoint reported the server limit, which admission must find
		// through the base conversation identity it names.
		recordCursorConversationContextLimit(SESSION, CONVERSATION_B, 200_000);
		expect(getCursorConversationContextLimit(SESSION, BASE_CONVERSATION)).toBe(200_000);
	});

	it("does not let a brand-new conversation inherit a rotated conversation's limit", () => {
		setCursorActiveConversationWire(SESSION, BASE_CONVERSATION, CONVERSATION_B);
		recordCursorConversationContextLimit(SESSION, CONVERSATION_B, 200_000);

		setCursorActiveConversationWire(SESSION, "new-base", "new-wire");

		expect(getCursorConversationContextLimit(SESSION, "new-base")).toBeUndefined();
		// The rotated conversation keeps its own reported limit.
		expect(getCursorConversationContextLimit(SESSION, BASE_CONVERSATION)).toBe(200_000);
	});

	it("never lets a zero checkpoint inherit the previous wire's limit after a rotation", () => {
		setCursorActiveConversationWire(SESSION, BASE_CONVERSATION, CONVERSATION_A);
		recordCursorConversationContextLimit(SESSION, CONVERSATION_A, 200_000);

		setCursorActiveConversationWire(SESSION, BASE_CONVERSATION, CONVERSATION_B);
		recordCursorConversationContextLimit(SESSION, CONVERSATION_B, 0);

		expect(getCursorConversationContextLimit(SESSION, BASE_CONVERSATION)).toBeUndefined();
		expect(getCursorConversationContextLimit(SESSION)).toBeUndefined();
	});

	it("forgets the published wire on teardown", () => {
		setCursorActiveConversationWire(SESSION, BASE_CONVERSATION, CONVERSATION_A);
		recordCursorConversationContextLimit(SESSION, CONVERSATION_A, 200_000);

		setCursorActiveConversationWire(SESSION, BASE_CONVERSATION, CONVERSATION_B);
		recordCursorConversationContextLimit(SESSION, CONVERSATION_B, 200_000);

		forgetCursorConversationContextLimit(SESSION);

		expect(getCursorConversationContextLimit(SESSION, BASE_CONVERSATION)).toBeUndefined();
	});

	it("keeps a limit when a later checkpoint for the same conversation omits it", () => {
		recordCursorConversationContextLimit(SESSION, CONVERSATION_A, 200_000);
		recordCursorConversationContextLimit(SESSION, CONVERSATION_A, 0);

		expect(getCursorConversationContextLimit(SESSION, CONVERSATION_A)).toBe(200_000);
	});

	it("does not return conversation A's limit for conversation B under the same session", () => {
		recordCursorConversationContextLimit(SESSION, CONVERSATION_A, 200_000);

		expect(getCursorConversationContextLimit(SESSION, CONVERSATION_B)).toBeUndefined();
	});

	it("drops the previous conversation's limit when a new conversation reports", () => {
		recordCursorConversationContextLimit(SESSION, CONVERSATION_A, 200_000);
		recordCursorConversationContextLimit(SESSION, CONVERSATION_B, 0);

		expect(getCursorConversationContextLimit(SESSION, CONVERSATION_A)).toBeUndefined();
		expect(getCursorConversationContextLimit(SESSION, CONVERSATION_B)).toBeUndefined();
		expect(getCursorConversationContextLimit(SESSION)).toBeUndefined();
	});

	it("returns only the active conversation's limit when conversations alternate", () => {
		recordCursorConversationContextLimit(SESSION, CONVERSATION_A, 200_000);
		recordCursorConversationContextLimit(SESSION, CONVERSATION_B, 262_000);

		expect(getCursorConversationContextLimit(SESSION, CONVERSATION_B)).toBe(262_000);
		expect(getCursorConversationContextLimit(SESSION, CONVERSATION_A)).toBeUndefined();

		recordCursorConversationContextLimit(SESSION, CONVERSATION_A, 200_000);

		expect(getCursorConversationContextLimit(SESSION, CONVERSATION_A)).toBe(200_000);
		expect(getCursorConversationContextLimit(SESSION, CONVERSATION_B)).toBeUndefined();
	});

	it("does not leak a limit across sessions", () => {
		recordCursorConversationContextLimit(SESSION, CONVERSATION_A, 200_000);

		expect(getCursorConversationContextLimit("other-session")).toBeUndefined();
		expect(getCursorConversationContextLimit("other-session", CONVERSATION_A)).toBeUndefined();
	});

	it("scopes the same conversation id independently per session", () => {
		recordCursorConversationContextLimit(SESSION, CONVERSATION_A, 200_000);
		recordCursorConversationContextLimit("other-session", CONVERSATION_A, 262_000);

		expect(getCursorConversationContextLimit(SESSION, CONVERSATION_A)).toBe(200_000);
		expect(getCursorConversationContextLimit("other-session", CONVERSATION_A)).toBe(262_000);
	});

	it("forgets every conversation on teardown without touching other sessions", () => {
		recordCursorConversationContextLimit(SESSION, CONVERSATION_A, 200_000);
		recordCursorConversationContextLimit(SESSION, CONVERSATION_B, 262_000);
		recordCursorConversationContextLimit("other-session", CONVERSATION_A, 262_000);

		forgetCursorConversationContextLimit(SESSION);

		expect(getCursorConversationContextLimit(SESSION)).toBeUndefined();
		expect(getCursorConversationContextLimit(SESSION, CONVERSATION_A)).toBeUndefined();
		expect(getCursorConversationContextLimit(SESSION, CONVERSATION_B)).toBeUndefined();
		expect(getCursorConversationContextLimit("other-session", CONVERSATION_A)).toBe(262_000);

		forgetCursorConversationContextLimit();
		expect(getCursorConversationContextLimit("other-session", CONVERSATION_A)).toBeUndefined();
	});

	it("ignores a missing session id", () => {
		recordCursorConversationContextLimit(undefined, CONVERSATION_A, 200_000);

		expect(getCursorConversationContextLimit(undefined, CONVERSATION_A)).toBeUndefined();
	});

	it("ignores a missing conversation id", () => {
		recordCursorConversationContextLimit(SESSION, undefined, 200_000);

		expect(getCursorConversationContextLimit(SESSION)).toBeUndefined();
	});
});
