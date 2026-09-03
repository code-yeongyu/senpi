import type { AgentMessage } from "@earendil-works/pi-agent-core";
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
import { convertToLlm } from "../../../src/core/messages.ts";

const ACCOUNT = "default";
const MODEL = "claude-opus-5";
const SYSTEM_PROMPT_HASH = "system-prompt-hash";
const TOOLSET_HASH = "toolset-hash";

function userMessage(text: string) {
	return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: 1 };
}

function customMessage(customType: string, text: string): AgentMessage {
	return { role: "custom", customType, content: text, display: false, timestamp: 1 };
}

function convertedCustom(customType: string, text: string) {
	const [message] = convertToLlm([customMessage(customType, text)]);
	if (message?.role !== "user") throw new Error(`custom message ${customType} did not convert to user role`);
	return message;
}

function notice(n: number) {
	return convertedCustom(
		"omo-memory:notice",
		`<memory_notice>\n- ${n} previous messages between you and the user are stored in recall memory\n</memory_notice>`,
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
		sdkSessionIdConfirmed: true,
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

const VOLATILE_CUSTOM_TYPES = [
	"omo-memory:notice",
	"mindy-team:context-block",
	"senpi-task.usage",
	"senpi-monitor:notification",
	"omo-senpi:wake",
	"senpi-terminal:notification",
	"omo-ultrawork:directive",
	"omo-mass-ulw:skill-pointer",
] as const;

describe("volatile hook continuity", () => {
	const prior = [userMessage("task1"), notice(8), toolResult("t1")];
	const rewrittenNotice = [userMessage("task1"), notice(186), toolResult("t1")];
	const prependedNotice = [notice(280), userMessage("task1"), notice(8), toolResult("t1")];
	const appended = [...prior, userMessage("task2"), notice(999)];
	const realEdit = [userMessage("task1-edited"), notice(8), toolResult("t1")];

	it("hashes convertToLlm custom-message output by provenance kind while keeping every hook transmitted", () => {
		for (const customType of VOLATILE_CUSTOM_TYPES) {
			const first = convertedCustom(customType, `${customType}: first body`);
			const second = convertedCustom(customType, `${customType}: rewritten body`);
			expect(isTransmittedMessage(first), customType).toBe(true);
			expect(sentMessageHashes([first]), customType).toEqual(sentMessageHashes([second]));
		}
	});

	it("keeps append-only goal continuations and ordinary user content hash-significant", () => {
		const firstGoal = convertedCustom("goal-continuation", "Continue goal: first body");
		const rewrittenGoal = convertedCustom("goal-continuation", "Continue goal: rewritten body");
		expect(sentMessageHashes([firstGoal])).not.toEqual(sentMessageHashes([rewrittenGoal]));
		expect(sentMessageHashes([userMessage("task1")])).not.toEqual(sentMessageHashes([userMessage("task1-edited")]));
	});

	it("reattaches after a hook rewrite, but still diverges on a structural prepend or real user rewrite", () => {
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
