import { describe, expect, it } from "vitest";
import {
	type ContinuityBindingSnapshot,
	type ContinuityEntrySnapshot,
	decideNativeContinuity,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-continuity.ts";
import {
	isTransmittedMessage,
	sentHashPrefixDigest,
	sentMessageHashes,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/session-sync.ts";

const ACCOUNT = "default";
const MODEL = "claude-opus-5";
const SYSTEM_PROMPT_HASH = "system-prompt-hash";
const TOOLSET_HASH = "toolset-hash";

function userMessage(text: string) {
	return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 };
}

function notice(n: number) {
	return userMessage(
		`<memory_notice>\n- ${n} previous messages between you and the user are stored in recall memory\n</memory_notice>`,
	);
}

function goalContinuation(tokens: number) {
	return userMessage(
		`Continue working toward the active thread goal.\n\n<untrusted_objective>\nship it\n</untrusted_objective>\n\nUsage so far:\n- Tokens used: ${tokens}`,
	);
}

function toolResult(id: string) {
	return {
		role: "toolResult" as const,
		toolCallId: id,
		toolName: "bash",
		content: [{ type: "text" as const, text: "ok" }],
		timestamp: 1,
	};
}

function hashesOf(messages: ReadonlyArray<{ role: string }>): string[] {
	return sentMessageHashes(messages.filter(isTransmittedMessage));
}

function bindingFrom(messages: ReadonlyArray<{ role: string }>): ContinuityBindingSnapshot {
	const hashes = hashesOf(messages);
	return {
		sdkSessionId: "sdk-1",
		accountName: ACCOUNT,
		modelId: MODEL,
		systemPromptHash: SYSTEM_PROMPT_HASH,
		toolsetHash: TOOLSET_HASH,
		sentCount: hashes.length,
		sentHashes: hashes,
		sentPrefixHash: sentHashPrefixDigest(hashes),
		lastAssistantUuid: null,
	};
}

function entryFrom(messages: ReadonlyArray<{ role: string }>): ContinuityEntrySnapshot {
	const sentHashes = hashesOf(messages);
	return {
		sdkSessionId: "sdk-1",
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

const fingerprint = { systemPromptHash: SYSTEM_PROMPT_HASH, toolsetHash: TOOLSET_HASH };

describe("volatile hook continuity", () => {
	const prior = [userMessage("task1"), notice(8), toolResult("t1")];
	const rewrittenNotice = [userMessage("task1"), notice(186), toolResult("t1")];
	const prependedNotice = [notice(280), userMessage("task1"), notice(8), toolResult("t1")];
	const appended = [
		userMessage("task1"),
		notice(8),
		toolResult("t1"),
		userMessage("task2"),
		notice(999),
		goalContinuation(12),
	];
	const realEdit = [userMessage("task1-edited"), notice(8), toolResult("t1")];

	it("keeps converted hooks in the transmitted set but hashes them by kind, not body", () => {
		expect(isTransmittedMessage(notice(8))).toBe(true);
		expect(isTransmittedMessage(goalContinuation(1))).toBe(true);
		expect(isTransmittedMessage(userMessage("task1"))).toBe(true);
		expect(isTransmittedMessage(toolResult("t1"))).toBe(true);
		expect(isTransmittedMessage(userMessage("Continue working toward the active thread goal"))).toBe(true);
		expect(sentMessageHashes([notice(8)])).toEqual(sentMessageHashes([notice(186)]));
		expect(sentMessageHashes([goalContinuation(1)])).toEqual(sentMessageHashes([goalContinuation(99)]));
		expect(sentMessageHashes([userMessage("task1")])).not.toEqual(sentMessageHashes([userMessage("task1-edited")]));
	});

	it("reattaches after a hook rewrite, but still diverges on prepend or a real user rewrite", () => {
		const binding = bindingFrom(prior);
		const input = {
			entry: undefined,
			binding,
			accountName: ACCOUNT,
			modelId: MODEL,
			fingerprint,
			transcriptAvailable: true,
			idleExpired: false,
		};
		expect(decideNativeContinuity({ ...input, currentHashes: hashesOf(rewrittenNotice) })).toEqual({
			kind: "reattach",
			sdkSessionId: "sdk-1",
			from: 3,
			reason: "registry_miss",
		});
		expect(decideNativeContinuity({ ...input, currentHashes: hashesOf(prependedNotice) })).toEqual({
			kind: "flatten",
			reason: "sent_stream_diverged",
		});
		expect(decideNativeContinuity({ ...input, currentHashes: hashesOf(appended) })).toEqual({
			kind: "reattach",
			sdkSessionId: "sdk-1",
			from: 3,
			reason: "registry_miss",
		});
		expect(decideNativeContinuity({ ...input, currentHashes: hashesOf(realEdit) })).toEqual({
			kind: "flatten",
			reason: "sent_stream_diverged",
		});
	});

	it("keeps an in-process hook rewrite as a delta", () => {
		const entry = entryFrom(prior);
		const input = {
			entry,
			binding: undefined,
			accountName: ACCOUNT,
			modelId: MODEL,
			fingerprint,
			transcriptAvailable: true,
			idleExpired: false,
		};
		expect(decideNativeContinuity({ ...input, currentHashes: hashesOf(rewrittenNotice) })).toEqual({
			kind: "delta",
			from: 3,
		});
		const edit = decideNativeContinuity({ ...input, currentHashes: hashesOf(realEdit) });
		expect(edit.kind === "flatten" || edit.kind === "fork").toBe(true);
		expect("reason" in edit ? edit.reason : undefined).toBe("sent_stream_diverged");
	});
});
