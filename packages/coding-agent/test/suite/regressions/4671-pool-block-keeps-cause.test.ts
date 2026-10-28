/**
 * senpi#4671: when one account fails while every other account is already blocked, the failure that
 * blocked it must survive (the pool state rides along as context), and every block that is saved is
 * written to the log, from a turn's failover and from the usage poll alike.
 */
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { AUTH_BLOCK_REPROBE_MS } from "../../../src/core/credential-pool/auth-reprobe.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import {
	type AccountSlot,
	type AnthropicSubscriptionCredential,
	addAccount,
	emptyCredential,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	AllAccountsBlockedError,
	selectAccount,
} from "../../../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import { classifySdkError } from "../../../src/core/extensions/builtin/anthropic-subscription/errors.ts";
import {
	ClassifiedSdkError,
	runFailover,
} from "../../../src/core/extensions/builtin/anthropic-subscription/failover.ts";
import {
	overrideContinuityObservabilityBoundary,
	resetContinuityObservabilityBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-observability.ts";
import { withAuthGuidance } from "../../../src/core/extensions/builtin/anthropic-subscription/stream-guidance.ts";
import { listPollAccounts, SIGN_IN_NEEDED } from "../../../src/core/subscription-limits/usage-accounts.ts";

const NOW = Date.parse("2026-10-28T12:53:51Z");
const BRAVO_FREE_AT = NOW + 2 * 60 * 60 * 1_000;

const alpha: AccountSlot = {
	name: "alpha",
	refresh: "r-alpha",
	access: "a-alpha",
	expires: NOW + 3_600_000,
	source: "login",
};
const bravo: AccountSlot = {
	name: "bravo",
	refresh: "r-bravo",
	access: "a-bravo",
	expires: NOW + 3_600_000,
	source: "login",
	blockedUntil: BRAVO_FREE_AT,
	blockReason: "rate_limit",
	blockedAt: NOW - 60_000,
};

type Logged = { event: string; data: Record<string, unknown> };

function captureLog(): Logged[] {
	const logged: Logged[] = [];
	overrideContinuityObservabilityBoundary({ log: (event, data) => logged.push({ event, data }) });
	return logged;
}

afterEach(() => resetContinuityObservabilityBoundary());

async function storeWith(accounts: readonly AccountSlot[]) {
	const store = new InMemoryCredentialStore();
	await store.modify("anthropic-subscription", async () =>
		accounts.reduce<AnthropicSubscriptionCredential>(
			(credential, account) => addAccount(credential, account),
			emptyCredential(),
		),
	);
	return store;
}

async function drain(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
	const events: unknown[] = [];
	for await (const event of iterable) events.push(event);
	return events;
}

describe("an account block keeps the failure that caused it (senpi#4671)", () => {
	it("keeps the original auth failure when no other account can be selected, and logs the block", async () => {
		const logged = captureLog();
		const store = await storeWith([alpha, bravo]);
		const attempts: string[] = [];

		const failure = await drain(
			runFailover({
				accounts: [alpha, bravo],
				selectFn: (pool) => selectAccount(pool, { sessionId: "pool-block-cause", now: NOW }),
				runAttempt: async function* (slot) {
					attempts.push(slot.name);
					yield* [];
					throw new Error("authentication_failed: OAuth token has been revoked");
				},
				classify: classifySdkError,
				store,
				providerId: "anthropic-subscription",
				now: () => NOW,
			}),
		).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect(attempts).toEqual(["alpha"]);
		expect(failure).toBeInstanceOf(ClassifiedSdkError);
		const classified = failure as ClassifiedSdkError;
		expect(classified.classification.kind).toBe("auth_error");
		expect(classified.message).toContain("authentication_failed");
		expect(classified.poolState).toBeInstanceOf(AllAccountsBlockedError);
		expect(classified.poolState?.soonestUnblockAt).toBe(NOW + AUTH_BLOCK_REPROBE_MS);

		const blocks = logged.filter((entry) => entry.event === "account_blocked");
		expect(blocks).toEqual([
			{
				event: "account_blocked",
				data: {
					account: "alpha",
					reason: "auth_error",
					until: new Date(NOW + AUTH_BLOCK_REPROBE_MS).toISOString(),
					shared: true,
					detail: "authentication_failed: OAuth token has been revoked",
				},
			},
		]);
	});

	it("lists every account's state and names the account that needs /login", () => {
		const authBlocked: AccountSlot = {
			...alpha,
			blockedUntil: NOW + AUTH_BLOCK_REPROBE_MS,
			blockReason: "auth_error",
			blockedAt: NOW,
		};
		let thrown: unknown;
		try {
			selectAccount([authBlocked, bravo], { now: NOW });
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(AllAccountsBlockedError);
		const blocked = thrown as AllAccountsBlockedError;
		expect(blocked.message).toMatch(/^All Anthropic Subscription accounts are blocked until /);
		expect(blocked.accounts).toEqual([
			{ name: "alpha", reason: "auth_error", until: NOW + AUTH_BLOCK_REPROBE_MS },
			{ name: "bravo", reason: "rate_limit", until: BRAVO_FREE_AT },
		]);
		expect(blocked.message).toContain(
			`alpha: auth_error until ${new Date(NOW + AUTH_BLOCK_REPROBE_MS).toISOString()} (run /login anthropic-subscription for alpha)`,
		);
		expect(blocked.message).toContain(`bravo: rate_limit until ${new Date(BRAVO_FREE_AT).toISOString()}`);
		expect(blocked.message).not.toContain("/login anthropic-subscription for bravo");
		const shown = withAuthGuidance(blocked, blocked.message);
		expect(shown).toContain(
			`  alpha: auth_error until ${new Date(NOW + AUTH_BLOCK_REPROBE_MS).toISOString()} - run /login anthropic-subscription for this account`,
		);
		expect(shown).toContain(`  bravo: rate_limit until ${new Date(BRAVO_FREE_AT).toISOString()}`);
	});

	it("logs the block the usage poll saves when the token endpoint rejects a login", async () => {
		const logged = captureLog();
		const store = AuthStorage.inMemory({
			"anthropic-subscription": {
				type: "oauth",
				access: "claude-sdk-oauth-managed",
				refresh: "claude-sdk-oauth-managed",
				expires: 4102444800000,
				accounts: [{ name: "work", access: "a-work", refresh: "r-work", expires: NOW - 1, source: "login" }],
			},
		} as never);
		const accounts = await listPollAccounts({
			store,
			env: () => undefined,
			refresher: async () => {
				throw Object.assign(new Error("HTTP request failed. status=401; body=unauthorized"), { status: 401 });
			},
			now: () => NOW,
		});

		expect(await accounts[0]?.access(new AbortController().signal)).toEqual({ error: SIGN_IN_NEEDED });
		expect(logged.filter((entry) => entry.event === "account_blocked")).toEqual([
			{
				event: "account_blocked",
				data: {
					account: "work",
					reason: "auth_error",
					until: new Date(NOW + AUTH_BLOCK_REPROBE_MS).toISOString(),
					shared: true,
					detail: "usage_poll_token_rejected",
				},
			},
		]);
	});
});
