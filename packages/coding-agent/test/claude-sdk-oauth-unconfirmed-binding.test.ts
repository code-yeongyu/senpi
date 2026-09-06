import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createAttemptMessages } from "../src/core/extensions/builtin/claude-sdk-oauth/auth-attempt.ts";
import type { SdkQueryHandle } from "../src/core/extensions/builtin/claude-sdk-oauth/sdk-boundary.ts";
import { decideNativeContinuity } from "../src/core/extensions/builtin/claude-sdk-oauth/session-continuity.ts";
import { observeSessionSyncDecision } from "../src/core/extensions/builtin/claude-sdk-oauth/session-observability.ts";
import { forgetBinding, getBinding } from "../src/core/extensions/builtin/claude-sdk-oauth/session-reattach.ts";
import {
	closeSession,
	getOrCreateSession,
	getSession,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../src/core/extensions/builtin/claude-sdk-oauth/session-registry.ts";
import { createSessionTurnAttempt } from "../src/core/extensions/builtin/claude-sdk-oauth/session-turn-attempt.ts";

class ScriptedQuery implements SdkQueryHandle, AsyncIterator<SDKMessage> {
	private done = false;
	private readonly queued: SDKMessage[] = [];
	private readonly readers: Array<(value: IteratorResult<SDKMessage>) => void> = [];

	[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
		return this;
	}

	next(): Promise<IteratorResult<SDKMessage>> {
		const value = this.queued.shift();
		if (value) return Promise.resolve({ value, done: false });
		if (this.done) return Promise.resolve({ value: undefined, done: true });
		return new Promise((resolve) => this.readers.push(resolve));
	}

	emit(message: SDKMessage): void {
		const reader = this.readers.shift();
		if (reader) reader({ value: message, done: false });
		else this.queued.push(message);
	}

	async interrupt(): Promise<void> {}

	close(): void {
		this.done = true;
		for (const reader of this.readers.splice(0)) reader({ value: undefined, done: true });
	}
}

const SESSION_ID = "unconfirmed-binding";
const HASHES = ["turn-hash"];
const userContent = { role: "user", content: "hello" } as const;

function replay(uuid: string, sessionId: string): SDKMessage {
	return {
		type: "user",
		message: userContent,
		parent_tool_use_id: null,
		uuid,
		session_id: sessionId,
		isReplay: true,
	} as SDKMessage;
}

const API_FAILURE =
	"API Error: 400 Claude Code 2.1.241 does not support this model; version 2.1.251 or newer is required.";
const RESUME_MISSING = "Claude Code returned an error result: No conversation found with session ID: dead-id";

function result(uuid: string, sessionId: string, failure: string | false): SDKMessage {
	return {
		type: "result",
		subtype: "success",
		user_message_uuid: uuid,
		uuid: "result",
		session_id: sessionId,
		is_error: failure !== false,
		result: failure === false ? "done" : failure,
	} as unknown as SDKMessage;
}

/** The NEXT user turn's admission (a new message, so the same-turn retry checkpoint does not apply). */
function decide(binding: ReturnType<typeof getBinding>) {
	return decideNativeContinuity({
		entry: undefined,
		binding: binding ? { ...binding, sentPrefixHash: undefined } : undefined,
		currentHashes: [...HASHES, "next-turn-hash"],
		accountName: "default",
		modelId: "claude-test",
		fingerprint: { toolsetHash: "tools-v1", systemPromptHash: "prompt-v1" },
		transcriptAvailable: true,
	});
}

function init(sessionId: string): SDKMessage {
	return { type: "system", subtype: "init", session_id: sessionId } as unknown as SDKMessage;
}

function fixture(resume?: string) {
	const query = new ScriptedQuery();
	overrideSessionRegistryBoundary({ queryFactory: () => query });
	const entry = getOrCreateSession({
		senpiSessionId: SESSION_ID,
		accountName: "default",
		modelId: "claude-test",
		toolsetHash: "tools-v1",
		systemPromptHash: "prompt-v1",
		options: {},
		...(resume ? { resume: { sdkSessionId: resume } } : {}),
	});
	const attempt = createSessionTurnAttempt(entry, userContent, HASHES, undefined, { emit() {} });
	return { query, entry, attempt };
}

async function submittedMessage(entry: { inputController: AsyncIterable<SDKUserMessage> }): Promise<SDKUserMessage> {
	const item = await entry.inputController[Symbol.asyncIterator]().next();
	if (item.done) throw new Error("Expected a submitted user message");
	return item.value;
}

async function consume(messages: AsyncIterable<SDKMessage>): Promise<void> {
	for await (const _message of messages) {
		// Exhaust the attempt so it publishes or forgets its retry checkpoint.
	}
}

afterEach(() => {
	closeSession(SESSION_ID, "test_cleanup");
	forgetBinding(SESSION_ID);
	resetSessionRegistryBoundary();
});

describe("claude-sdk-oauth unconfirmed continuity bindings", () => {
	it("never resumes a cold-seed id that failed before the SDK acknowledged it (#7562)", async () => {
		const { query, entry, attempt } = fixture();
		const consuming = consume(attempt.messages);
		const submitted = await submittedMessage(entry);
		// Neither init nor a replay echo arrived: the id was only ever minted locally.
		query.emit(result(submitted.uuid!, entry.sdkSessionId, API_FAILURE));

		await expect(consuming).rejects.toThrow("does not support this model");
		expect(getSession(SESSION_ID)).toBeUndefined();
		const binding = getBinding(SESSION_ID);
		expect(binding).toMatchObject({ sdkSessionId: entry.sdkSessionId, sdkSessionIdConfirmed: false });
		// A cold seed, not a resume of the dead id.
		expect(decide(binding)).toEqual({ kind: "flatten", reason: "session_unconfirmed" });
	});

	it("confirms the id from the SDK's replay echo even without an init message", async () => {
		const { query, entry, attempt } = fixture();
		const consuming = consume(attempt.messages);
		const submitted = await submittedMessage(entry);
		query.emit(replay(submitted.uuid!, entry.sdkSessionId));
		query.emit(result(submitted.uuid!, entry.sdkSessionId, API_FAILURE));

		await expect(consuming).rejects.toThrow("does not support this model");
		const binding = getBinding(SESSION_ID);
		expect(binding).toMatchObject({ sdkSessionId: entry.sdkSessionId, sdkSessionIdConfirmed: true });
		expect(decide(binding).kind).toBe("reattach");
	});

	it("forgets a resumed id that Claude Code reports as missing", async () => {
		const { query, entry, attempt } = fixture("sdk-dead");
		const consuming = consume(attempt.messages);
		const submitted = await submittedMessage(entry);
		query.emit(result(submitted.uuid!, "sdk-dead", RESUME_MISSING));

		await expect(consuming).rejects.toThrow("No conversation found");
		expect(getBinding(SESSION_ID)).toBeUndefined();
		expect(decide(getBinding(SESSION_ID))).toEqual({ kind: "bootstrap" });
	});

	it("keeps a dead resumed id forgotten through the retained-attempt discard path", async () => {
		// The production lane consumes the attempt through createAttemptMessages, whose
		// retainedAttemptMessages() wrapper calls discard() on failure; discard must not
		// re-publish the checkpoint of an id Claude Code already declared missing.
		const { query, entry, attempt } = fixture("sdk-dead-wrapped");
		const messages = await createAttemptMessages(
			{ prompt: "", query: () => query, createAttempt: () => attempt },
			{ accountName: "default", accounts: [], authLane: "oauth-slots", options: {} },
		);
		const consuming = consume(messages);
		const submitted = await submittedMessage(entry);
		query.emit(result(submitted.uuid!, "sdk-dead-wrapped", RESUME_MISSING));

		await expect(consuming).rejects.toThrow("No conversation found");
		expect(getBinding(SESSION_ID)).toBeUndefined();
		expect(decide(getBinding(SESSION_ID))).toEqual({ kind: "bootstrap" });
	});

	it("reports session_unconfirmed through the continuity observation instead of other", () => {
		const observation = observeSessionSyncDecision({
			kind: "cold-seed",
			reason: "session_unconfirmed",
			deltaMessages: 1,
			firstTurn: false,
			senpiSessionId: SESSION_ID,
		});
		expect(observation).toMatchObject({ kind: "flatten", reason: "session_unconfirmed" });
	});

	it("retains a retry checkpoint after init confirms the SDK session id", async () => {
		const { query, entry, attempt } = fixture();
		const consuming = consume(attempt.messages);
		const submitted = await submittedMessage(entry);
		const confirmedId = "sdk-confirmed";
		query.emit(init(confirmedId));
		query.emit(replay(submitted.uuid!, confirmedId));
		query.emit(result(submitted.uuid!, confirmedId, API_FAILURE));

		await expect(consuming).rejects.toThrow("does not support this model");
		expect(getBinding(SESSION_ID)).toMatchObject({
			sdkSessionId: confirmedId,
			sentCount: 0,
			sdkSessionIdConfirmed: true,
		});
	});

	it("records a successful confirmed turn exactly as before", async () => {
		const { query, entry, attempt } = fixture();
		const consuming = consume(attempt.messages);
		const submitted = await submittedMessage(entry);
		query.emit(init(entry.sdkSessionId));
		query.emit(replay(submitted.uuid!, entry.sdkSessionId));
		query.emit(result(submitted.uuid!, entry.sdkSessionId, false));

		await consuming;
		expect(getBinding(SESSION_ID)).toMatchObject({
			sdkSessionId: entry.sdkSessionId,
			sdkSessionIdConfirmed: true,
			sentCount: 1,
			sentHashes: HASHES,
		});
	});

	it("treats a resume-created entry as already confirmed", async () => {
		const resumedId = "sdk-resumed";
		const { query, entry, attempt } = fixture(resumedId);
		const consuming = consume(attempt.messages);
		const submitted = await submittedMessage(entry);
		query.emit(result(submitted.uuid!, resumedId, API_FAILURE));

		await expect(consuming).rejects.toThrow("does not support this model");
		expect(getBinding(SESSION_ID)).toMatchObject({
			sdkSessionId: resumedId,
			sentCount: 0,
			sdkSessionIdConfirmed: true,
		});
	});
});
