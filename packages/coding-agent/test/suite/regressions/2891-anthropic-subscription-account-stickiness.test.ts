import { type CredentialStore, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type AccountSlot,
	type AnthropicSubscriptionCredential,
	addAccount,
	emptyCredential,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	rendezvousOrder,
	selectAccount,
} from "../../../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import { classifySdkError } from "../../../src/core/extensions/builtin/anthropic-subscription/errors.ts";
import { runFailover } from "../../../src/core/extensions/builtin/anthropic-subscription/failover.ts";
import {
	type ContinuityDecisionInput,
	decideNativeContinuity,
} from "../../../src/core/extensions/builtin/anthropic-subscription/session-continuity.ts";

type AttemptEvent = { type: "done"; value: string };

const PROVIDER = "anthropic-subscription";
const SESSION = "senpi-2891-session";
const pool: AccountSlot[] = [
	{ name: "alpha", refresh: "r-alpha", access: "a-alpha", expires: 1, source: "login" },
	{ name: "bravo", refresh: "r-bravo", access: "a-bravo", expires: 1, source: "login" },
];
const [home, other] = rendezvousOrder(SESSION, pool).map((account) => account.name) as [string, string];

async function storeWithPool(): Promise<CredentialStore> {
	const store = new InMemoryCredentialStore();
	await store.modify(PROVIDER, async () =>
		pool.reduce<AnthropicSubscriptionCredential>(
			(credential, account) => addAccount(credential, account),
			emptyCredential(),
		),
	);
	return store;
}

async function storedPool(store: CredentialStore): Promise<AccountSlot[]> {
	return ((await store.read(PROVIDER)) as AnthropicSubscriptionCredential).accounts ?? [];
}

type Turn = { served: string; attempts: string[]; sleeps: number[] };

let attemptLog: string[] = [];
let sleepLog: number[] = [];

async function runTurn(
	store: CredentialStore,
	now: number,
	preferredAccount: string | undefined,
	fail: (account: string, attemptOnAccount: number) => string | undefined,
): Promise<Turn> {
	const attempts: string[] = [];
	const sleeps: number[] = [];
	attemptLog = attempts;
	sleepLog = sleeps;
	let served = "";
	const stream = runFailover<AttemptEvent>({
		accounts: await storedPool(store),
		selectFn: (accounts) =>
			selectAccount(accounts, {
				sessionId: SESSION,
				now,
				...(preferredAccount === undefined ? {} : { preferredAccount }),
			}),
		runAttempt: async function* (slot) {
			attempts.push(slot.name);
			const failure = fail(slot.name, attempts.filter((name) => name === slot.name).length);
			if (failure !== undefined) throw new Error(failure);
			served = slot.name;
			yield { type: "done", value: slot.name };
		},
		classify: classifySdkError,
		store,
		providerId: PROVIDER,
		now: () => now,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	});
	const events: AttemptEvent[] = [];
	for await (const event of stream) events.push(event);
	expect(events).toHaveLength(served === "" ? 0 : 1);
	return { served, attempts, sleeps };
}

function configDirDecision(entryAccount: string, servingAccount: string, crossAccountResumeSupported: boolean) {
	const input: ContinuityDecisionInput = {
		entry: {
			sdkSessionId: "sdk-1",
			accountName: entryAccount,
			modelId: "claude-opus-5-5",
			systemPromptHash: "prompt",
			toolsetHash: "tools",
			sentCount: 2,
			sentHashes: ["h1", "h2"],
			lastAssistantUuid: "uuid-a2",
			assistantUuidByIndex: new Map([[2, "uuid-a2"]]),
			pendingForkReason: null,
		},
		binding: undefined,
		currentHashes: ["h1", "h2", "h3"],
		accountName: servingAccount,
		modelId: "claude-opus-5-5",
		fingerprint: { systemPromptHash: "prompt", toolsetHash: "tools" },
		transcriptAvailable: true,
		crossAccountResumeSupported,
	};
	return decideNativeContinuity(input);
}

describe("senpi#2891 a session stays on its account unless the account cannot serve", () => {
	it("retries a transient failure on the same account instead of moving the session", async () => {
		// given the session's account fails once with an overload
		const store = await storeWithPool();

		// when the turn runs
		const turn = await runTurn(store, 10_000, home, (account, n) =>
			account === home && n === 1 ? "HTTP 529 overloaded" : undefined,
		);

		// then it is retried on the same account after the backoff, and nothing is blocked
		expect(turn.attempts).toEqual([home, home]);
		expect(turn.served).toBe(home);
		expect(turn.sleeps).toEqual([1_000]);
		expect((await storedPool(store)).every((account) => account.blockedUntil === undefined)).toBe(true);
	});

	it("rotates after the bounded same-account retries are spent", async () => {
		// given the session's account keeps failing with a network error
		const store = await storeWithPool();

		// when the turn runs
		const turn = await runTurn(store, 10_000, home, (account) =>
			account === home ? "fetch failed: ECONNRESET" : undefined,
		);

		// then it tries the account three times with a doubling delay, then moves on
		expect(turn.attempts).toEqual([home, home, home, other]);
		expect(turn.sleeps).toEqual([1_000, 2_000]);
		expect(turn.served).toBe(other);
	});

	it("spends the transient retry budget once per turn when every account fails", async () => {
		// given an outage that overloads every account
		const store = await storeWithPool();

		// when the turn runs
		const turn = await runTurn(store, 10_000, home, () => "HTTP 529 overloaded").catch(() => undefined);

		// then the session's account is retried twice and the other account is tried once, not twice more
		expect(turn).toBeUndefined();
		expect(attemptLog).toEqual([home, home, home, other]);
		expect(sleepLog).toEqual([1_000, 2_000]);
	});

	it.each([
		["a usage limit", "You've hit your weekly limit \u00b7 resets 5am (Asia/Seoul)"],
		["a rate limit", "HTTP 429 too many requests"],
		["an auth failure", "authentication_failed"],
	])("still rotates at once on %s", async (_label, failure) => {
		// given the session's account is limited or rejected
		const store = await storeWithPool();

		// when the turn runs
		const turn = await runTurn(store, 10_000, home, (account) => (account === home ? failure : undefined));

		// then no same-account retry is spent and the next account serves
		expect(turn.attempts).toEqual([home, other]);
		expect(turn.sleeps).toEqual([]);
		expect(turn.served).toBe(other);
	});

	it("keeps the account the session moved to instead of bouncing back to the HRW winner", () => {
		// given the session's transcript now lives under the second account and the first is healthy again
		// when the next turn picks an account
		const selected = selectAccount(pool, { sessionId: SESSION, preferredAccount: other, now: 10_000 });

		// then it stays where the transcript is
		expect(selected.name).toBe(other);
	});

	it("leaves the preferred account when it is blocked", () => {
		// given the preferred account is usage-blocked
		const blocked = pool.map((account) =>
			account.name === other ? { ...account, blockedUntil: 20_000, blockReason: "rate_limit" as const } : account,
		);

		// when the next turn picks an account
		const selected = selectAccount(blocked, { sessionId: SESSION, preferredAccount: other, now: 10_000 });

		// then it fails over to the account that can serve
		expect(selected.name).toBe(home);
	});

	it("flattens a live config-dir session that changed account without trying a doomed reattach", () => {
		// when the serving account differs from the live session's account
		// then the config-dir lane re-seeds directly, while a shared-root lane still reattaches
		expect(configDirDecision(home, other, false)).toEqual({ kind: "flatten", reason: "cross_root_unsupported" });
		expect(configDirDecision(home, other, true)).toMatchObject({ kind: "reattach", reason: "account_changed" });
	});

	it("cuts config-dir re-seeds over a replayed day to the real account moves", async () => {
		// given a day of 200 turns 88 s apart (the reporter's median gap) with 10 transient
		// overloads on the session's account and one weekly limit on it at turn 150
		const store = await storeWithPool();
		const transientTurns = new Set([10, 25, 40, 55, 70, 85, 100, 115, 130, 145]);
		let previous: string | undefined;
		const moves: string[] = [];

		// when every turn picks its account and decides continuity like the config-dir lane does
		for (let turn = 0; turn < 200; turn++) {
			const now = 1_000_000 + turn * 88_000;
			const result = await runTurn(store, now, previous, (account, n) => {
				if (account !== home) return undefined;
				if (turn === 150) return "You've hit your weekly limit \u00b7 resets 5am (Asia/Seoul)";
				return transientTurns.has(turn) && n === 1 ? "HTTP 529 overloaded" : undefined;
			});
			if (previous !== undefined && previous !== result.served) {
				const decision = configDirDecision(previous, result.served, false);
				moves.push(`${turn}:${decision.kind}`);
			}
			previous = result.served;
		}

		// then only the weekly limit moves the session, and that move re-seeds directly
		expect(moves).toEqual(["150:flatten"]);
	});
});
