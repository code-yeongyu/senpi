import type { Context } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type ContinuityEntrySnapshot,
	decideNativeContinuity,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-continuity.ts";
import { sentMessageHashes, sentMessages } from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-sync.ts";

const ACCOUNT = "default";
const MODEL = "claude-opus-5";
const SYSTEM_PROMPT_HASH = "system-prompt-hash";
const TOOLSET_HASH = "toolset-hash";

function contextOf(messages: readonly unknown[]): Context {
	return { messages } as unknown as Context;
}

function userMessage(text: string) {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

/**
 * A user message carrying no content blocks. These appear transiently in
 * `context.messages` and are gone by the next provider call, so hashing one
 * shifts every later index and forces a full-history re-send.
 */
function emptyUserMessage() {
	return { role: "user", content: [], timestamp: 1 };
}

function toolResultMessage(toolCallId: string, text: string) {
	return { role: "toolResult", toolCallId, toolName: "bash", content: [{ type: "text", text }], timestamp: 1 };
}

function entryFrom(sentHashes: readonly string[]): ContinuityEntrySnapshot {
	return {
		sdkSessionId: "sdk-session",
		accountName: ACCOUNT,
		modelId: MODEL,
		systemPromptHash: SYSTEM_PROMPT_HASH,
		toolsetHash: TOOLSET_HASH,
		sentCount: sentHashes.length,
		sentHashes,
		lastAssistantUuid: "assistant-uuid",
		assistantUuidByIndex: new Map([[1, "assistant-uuid"]]),
		pendingForkReason: null,
		taintedReason: null,
	};
}

function decide(sentHashes: readonly string[], currentHashes: readonly string[]) {
	const decision = decideNativeContinuity({
		entry: entryFrom(sentHashes),
		binding: undefined,
		currentHashes,
		accountName: ACCOUNT,
		modelId: MODEL,
		fingerprint: { systemPromptHash: SYSTEM_PROMPT_HASH, toolsetHash: TOOLSET_HASH },
		transcriptAvailable: true,
		idleExpired: false,
	});
	// Compared as an explicit shape so the observed reason is printed on failure
	// instead of being collapsed into "omitted properties".
	return { kind: decision.kind, reason: "reason" in decision ? decision.reason : null };
}

function hashesFor(messages: readonly unknown[]): string[] {
	return sentMessageHashes(sentMessages(contextOf(messages)));
}

describe("claude-sdk-oauth: content-less user messages must not break sent-stream continuity", () => {
	it("excludes a content-less user message from the transmitted set", () => {
		const messages = [userMessage("real turn"), emptyUserMessage(), toolResultMessage("call-1", "output")];

		expect(sentMessages(contextOf(messages))).toHaveLength(2);
	});

	it("stays a delta when a transient content-less user message disappears", () => {
		// Turn 1: an empty user message sits between a tool result and the next
		// real user turn, exactly as observed in a live session.
		const turnOne = [
			toolResultMessage("call-0", "earlier output"),
			emptyUserMessage(),
			userMessage("Continue working toward the active thread goal"),
		];
		// Turn 2: the empty message is gone and a tool result is appended. The
		// real conversation is unchanged, so this must not be a divergence.
		const turnTwo = [
			toolResultMessage("call-0", "earlier output"),
			userMessage("Continue working toward the active thread goal"),
			toolResultMessage("call-1", "new output"),
		];

		expect(decide(hashesFor(turnOne), hashesFor(turnTwo))).toEqual({ kind: "delta", reason: null });
	});

	it("treats a plain append as a delta", () => {
		const turnOne = [userMessage("do the task")];
		const turnTwo = [...turnOne, toolResultMessage("call-1", "tool output")];

		expect(decide(hashesFor(turnOne), hashesFor(turnTwo))).toEqual({ kind: "delta", reason: null });
	});

	it("still detects a genuine rewrite of already-sent history", () => {
		const turnOne = [userMessage("do the task"), toolResultMessage("call-1", "tool output")];
		const rewritten = [userMessage("do the task"), toolResultMessage("call-1", "DIFFERENT output")];

		expect(decide(hashesFor(turnOne), hashesFor(rewritten))).toMatchObject({
			reason: "sent_stream_diverged",
		});
	});

	// The predicate must stay narrow: only a literal zero-block array is excluded.
	// Whitespace-only text and explicit empty-text blocks still produce transport
	// blocks, so dropping them would weaken fail-closed divergence detection.
	it("keeps whitespace-only and empty-text-block user messages hashed (fail-closed)", () => {
		const whitespaceOnly = { role: "user", content: [{ type: "text", text: "   " }], timestamp: 1 };
		const emptyTextBlock = { role: "user", content: [{ type: "text", text: "" }], timestamp: 1 };
		const realTurn = userMessage("real turn");

		const messages = [realTurn, whitespaceOnly, emptyTextBlock, toolResultMessage("call-1", "output")];

		// Only a literal content: [] message is dropped; these three stay.
		expect(sentMessages(contextOf(messages))).toHaveLength(4);
	});

	it("treats the disappearance of a whitespace-only user message as divergence", () => {
		const whitespaceOnly = { role: "user", content: [{ type: "text", text: "   " }], timestamp: 1 };
		const turnOne = [toolResultMessage("call-0", "out"), whitespaceOnly, userMessage("next")];
		const turnTwo = [toolResultMessage("call-0", "out"), userMessage("next"), toolResultMessage("call-1", "new")];

		// A whitespace-only message WAS transmitted, so its removal is a real rewrite.
		expect(decide(hashesFor(turnOne), hashesFor(turnTwo))).toMatchObject({
			reason: "sent_stream_diverged",
		});
	});
});
