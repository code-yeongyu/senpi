import { afterEach, describe, expect, it } from "vitest";
import type {
	SDKMessage,
	SDKUserMessage,
	SdkQueryHandle,
} from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import {
	forgetBinding,
	getBinding,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-reattach.ts";
import {
	closeSession,
	getOrCreateSession,
	overrideSessionRegistryBoundary,
	resetSessionRegistryBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-registry.ts";
import { createSessionTurnAttempt } from "../../../src/core/extensions/builtin/anthropic-subscription/session-turn-attempt.ts";

const SESSION_ID = "issue-1958-missing-message-uuid";
const LIVE_UUID = "11111111-1111-7111-8111-111111111111";
const DEAD_UUID = "22222222-2222-7222-8222-222222222222";

// Claude Code rejects a fork whose resumeSessionAt UUID is absent from its transcript with this
// exact wording; the lane has to recognize it the way it already recognizes a missing session id.
function missingMessageError(uuid: string): Error {
	return new Error(`No message found with message.uuid of: ${uuid}`);
}

function failingQuery(error: Error): SdkQueryHandle {
	return {
		[Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }),
		interrupt: () => Promise.resolve({}),
		close: () => {},
	} as unknown as SdkQueryHandle;
}

function seedEntry(error: Error) {
	overrideSessionRegistryBoundary({
		queryFactory: () => failingQuery(error),
		scheduleReap: () => ({ cancel: () => {}, unref: () => {} }),
	});
	const entry = getOrCreateSession({
		senpiSessionId: SESSION_ID,
		accountName: "account-a",
		modelId: "claude-test",
		toolsetHash: "toolset",
		systemPromptHash: "prompt",
		options: { cwd: "/tmp" },
	});
	entry.sdkSessionIdConfirmed = true;
	entry.sentCount = 2;
	entry.assistantUuidByIndex.set(1, LIVE_UUID);
	entry.assistantUuidByIndex.set(2, DEAD_UUID);
	return entry;
}

async function runFailingTurn(error: Error): Promise<void> {
	const entry = seedEntry(error);
	const attempt = createSessionTurnAttempt(
		entry,
		{ role: "user", content: [{ type: "text", text: "next turn" }] } as SDKUserMessage["message"],
		["hash-1", "hash-2", "hash-3"],
		undefined,
		{ emit: () => {} },
	);
	await expect(async () => {
		const drained: SDKMessage[] = [];
		for await (const message of attempt.messages as AsyncIterable<SDKMessage>) drained.push(message);
		return drained;
	}).rejects.toThrow();
}

describe("issue #1958: a rejected assistant UUID is never republished", () => {
	afterEach(() => {
		forgetBinding(SESSION_ID);
		closeSession(SESSION_ID, "test-teardown");
		resetSessionRegistryBoundary();
	});

	it("drops the UUID Claude Code reported missing from the retry checkpoint", async () => {
		await runFailingTurn(missingMessageError(DEAD_UUID));

		const binding = getBinding(SESSION_ID);
		// The checkpoint itself must still be published (a fix that forgot the whole binding
		// would also make the dead id disappear); only the rejected id is gone.
		expect(binding).toBeDefined();
		expect(binding?.lastAssistantUuid).toBeNull();
		expect(binding?.assistantUuidByIndex?.some(([, uuid]) => uuid === DEAD_UUID)).toBe(false);
	});

	// The surviving entry is recorded, not yet consumed: the decision table still flattens on a
	// null lastAssistantUuid until senpi#1973 lands, so this asserts the recorded state only.
	it("keeps an earlier mapped boundary recorded in the checkpoint for recovery (#1973)", async () => {
		await runFailingTurn(missingMessageError(DEAD_UUID));

		const binding = getBinding(SESSION_ID);
		expect(binding).toBeDefined();
		expect(binding?.assistantUuidByIndex?.some(([, uuid]) => uuid === LIVE_UUID)).toBe(true);
	});

	it("still republishes the checkpoint unchanged for an unrelated failure", async () => {
		await runFailingTurn(new Error("stream closed before the first token"));

		const binding = getBinding(SESSION_ID);
		expect(binding?.lastAssistantUuid).toBe(DEAD_UUID);
	});
});
