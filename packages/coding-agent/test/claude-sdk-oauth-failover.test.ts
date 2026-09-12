import { type CredentialStore, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type AccountSlot,
	addAccount,
	type ClaudeSdkOauthCredential,
	emptyCredential,
} from "../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";
import { rendezvousOrder, selectAccount } from "../src/core/extensions/builtin/claude-sdk-oauth/affinity.ts";
import { classifySdkError } from "../src/core/extensions/builtin/claude-sdk-oauth/errors.ts";
import { ClassifiedSdkError, runFailover } from "../src/core/extensions/builtin/claude-sdk-oauth/failover.ts";

type AttemptEvent =
	| { type: "text_delta"; delta: string }
	| { type: "toolcall_delta"; delta: string }
	| { type: "done"; value: string };

const accountPool: AccountSlot[] = [
	{ name: "alpha", refresh: "r-alpha", access: "a-alpha", expires: 1, source: "login" },
	{ name: "bravo", refresh: "r-bravo", access: "a-bravo", expires: 1, source: "login" },
	{ name: "charlie", refresh: "r-charlie", access: "a-charlie", expires: 1, source: "login" },
];
const now = 10_000;

async function storeWithAccounts(): Promise<CredentialStore> {
	const store = new InMemoryCredentialStore();
	await store.modify("claude-sdk-oauth", async () =>
		accountPool.reduce<ClaudeSdkOauthCredential>(
			(credential, account) => addAccount(credential, account),
			emptyCredential(),
		),
	);
	return store;
}

async function collect(iterable: AsyncIterable<AttemptEvent>): Promise<AttemptEvent[]> {
	const events: AttemptEvent[] = [];
	for await (const event of iterable) events.push(event);
	return events;
}

describe("Claude SDK OAuth failover", () => {
	it("classifies all SDK error values and HTTP 429/529 equivalents", () => {
		expect(classifySdkError("authentication_failed")).toEqual({ kind: "auth_error", retryable: true });
		expect(classifySdkError("oauth_org_not_allowed")).toEqual({ kind: "org_not_allowed", retryable: true });
		expect(classifySdkError("billing_error")).toEqual({ kind: "billing", retryable: true });
		expect(classifySdkError("rate_limit")).toEqual({ kind: "rate_limit", retryable: true });
		expect(classifySdkError("overloaded")).toEqual({ kind: "overloaded", retryable: true });
		expect(classifySdkError("invalid_request")).toEqual({ kind: "other", retryable: false });
		expect(classifySdkError("server_error")).toEqual({ kind: "other", retryable: true });
		expect(classifySdkError("HTTP 429 too many requests")).toEqual({ kind: "rate_limit", retryable: true });
		expect(classifySdkError("HTTP 529 overloaded")).toEqual({ kind: "overloaded", retryable: true });
	});

	it("treats Claude Code's prose subscription limits as rate limits", () => {
		// Real message from the CLI on an exhausted Pro/Max plan: no SDK error code
		// and no HTTP status, so without prose matching it classified as
		// non-retryable "other" and the exhausted account was never blocked — a
		// multi-account pool then never rotated past it.
		expect(classifySdkError("You've hit your weekly limit \u00b7 resets 5am (Asia/Seoul)")).toEqual({
			kind: "rate_limit",
			retryable: true,
		});
		expect(classifySdkError("You've reached your 5-hour limit")).toEqual({
			kind: "rate_limit",
			retryable: true,
		});
		expect(classifySdkError("Daily limit exceeded")).toEqual({ kind: "rate_limit", retryable: true });
	});

	it("treats SDK terminal_reason limit signals as rate limits", () => {
		// auth-lane appends `terminal_reason` to result errors because `subtype`
		// alone reports plain "error_during_execution" for a blocked subscription.
		expect(classifySdkError("Claude Code error_during_execution: blocking_limit")).toEqual({
			kind: "rate_limit",
			retryable: true,
		});
		expect(classifySdkError("Claude Code error_during_execution: rapid_refill_breaker")).toEqual({
			kind: "rate_limit",
			retryable: true,
		});
		expect(classifySdkError("Claude Code error_during_execution: model_error")).toEqual({
			kind: "other",
			retryable: false,
		});
	});

	it("still treats unrelated errors as non-retryable", () => {
		// The prose matcher must not swallow ordinary failures into the retry path.
		expect(classifySdkError("context window exceeded for this request")).toEqual({
			kind: "other",
			retryable: false,
		});
		expect(classifySdkError("connection reset by peer")).toEqual({ kind: "other", retryable: true });
	});

	it("walks HRW order after a rate limit, persists the cooldown, and emits failover", async () => {
		const store = await storeWithAccounts();
		const sessionId = "failover-session";
		const expected = rendezvousOrder(sessionId, accountPool).map((account) => account.name);
		const attempts: string[] = [];
		const failovers: string[] = [];
		const events = await collect(
			runFailover({
				accounts: accountPool,
				selectFn: (pool) => selectAccount(pool, { sessionId, now }),
				runAttempt: async function* (slot) {
					attempts.push(slot.name);
					if (attempts.length === 1) throw new Error("rate_limit retry-after-ms: 2500");
					yield { type: "done", value: slot.name };
				},
				classify: classifySdkError,
				store,
				providerId: "claude-sdk-oauth",
				now: () => now,
				onFailover: (event) => {
					failovers.push(`${event.account.name}:${event.classification.kind}`);
				},
			}),
		);

		expect(attempts).toEqual(expected.slice(0, 2));
		expect(events).toEqual([{ type: "done", value: expected[1] }]);
		expect(failovers).toEqual([`${expected[0]}:rate_limit`]);
		const credential = (await store.read("claude-sdk-oauth")) as ClaudeSdkOauthCredential;
		const blocked = credential.accounts?.find((account) => account.name === expected[0]);
		expect(blocked).toMatchObject({ blockReason: "rate_limit", blockedUntil: now + 2_500 });
	});

	it("does not transparently retry after text or a tool-call delta, but still blocks and emits failover", async () => {
		const store = await storeWithAccounts();
		const attempts: string[] = [];
		const failovers: string[] = [];
		const stream = runFailover({
			accounts: accountPool,
			selectFn: (pool) => selectAccount(pool, { sessionId: "post-delta", now }),
			runAttempt: async function* (slot) {
				attempts.push(slot.name);
				const textDelta: AttemptEvent = { type: "text_delta", delta: "partial" };
				const toolDelta: AttemptEvent = { type: "toolcall_delta", delta: '{"path":"x"}' };
				yield textDelta;
				yield toolDelta;
				throw new Error("rate_limit");
			},
			classify: classifySdkError,
			store,
			providerId: "claude-sdk-oauth",
			now: () => now,
			onFailover: (event) => {
				failovers.push(event.account.name);
			},
		});
		const emitted: AttemptEvent[] = [];
		await expect(
			(async () => {
				for await (const event of stream) emitted.push(event);
			})(),
		).rejects.toMatchObject({
			name: "ClassifiedSdkError",
			classification: { kind: "rate_limit", retryable: true },
			suppressTurnRetry: true,
		});

		expect(emitted).toEqual([
			{ type: "text_delta", delta: "partial" },
			{ type: "toolcall_delta", delta: '{"path":"x"}' },
		]);
		expect(attempts).toHaveLength(1);
		expect(failovers).toEqual(attempts);
		const credential = (await store.read("claude-sdk-oauth")) as ClaudeSdkOauthCredential;
		expect(credential.accounts?.find((account) => account.name === attempts[0])).toMatchObject({
			blockReason: "rate_limit",
		});
	});

	it("fails over on non-success result events before the first delta", async () => {
		const store = await storeWithAccounts();
		const attempts: string[] = [];
		const emitted: AttemptEvent[] = [];
		const stream = runFailover({
			accounts: accountPool,
			selectFn: (pool) => selectAccount(pool, { sessionId: "result-failover", now }),
			runAttempt: async function* (slot) {
				attempts.push(slot.name);
				if (attempts.length === 1) {
					const failure: AttemptEvent = { type: "done", value: "billing_error" };
					yield failure;
					return;
				}
				const done: AttemptEvent = { type: "done", value: slot.name };
				yield done;
			},
			classify: classifySdkError,
			store,
			providerId: "claude-sdk-oauth",
			now: () => now,
			errorFromEvent: (event) => (event.value === "billing_error" ? new Error("billing_error") : undefined),
		});
		for await (const event of stream) emitted.push(event);
		expect(attempts.length).toBe(2);
		expect(attempts[0]).not.toBe(attempts[1]);
		const last: AttemptEvent = { type: "done", value: attempts[1]! };
		expect(emitted.at(-1)).toEqual(last);
	});

	it("blocks authentication failures until re-login instead of assigning a time-based expiry", async () => {
		const store = await storeWithAccounts();
		const stream = runFailover({
			accounts: [accountPool[0]!],
			selectFn: (pool) => selectAccount(pool, { sessionId: "auth", now }),
			runAttempt: async function* (slot) {
				if (slot.name === accountPool[0]!.name) throw new Error("authentication_failed");
				const done: AttemptEvent = { type: "done", value: slot.name };
				yield done;
			},
			classify: classifySdkError,
			store,
			providerId: "claude-sdk-oauth",
			now: () => now,
		});
		await expect(collect(stream)).rejects.toBeInstanceOf(ClassifiedSdkError);
		const credential = (await store.read("claude-sdk-oauth")) as ClaudeSdkOauthCredential;
		expect(credential.accounts?.[0]).toMatchObject({ blockReason: "auth_error" });
		expect(credential.accounts?.[0]?.blockedUntil).toBeUndefined();
	});
});
