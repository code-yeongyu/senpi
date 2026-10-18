import { type CredentialStore, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	type AccountSlot,
	type AnthropicSubscriptionCredential,
	addAccount,
	emptyCredential,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { selectAccount } from "../../../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import { classifySdkError } from "../../../src/core/extensions/builtin/anthropic-subscription/errors.ts";
import { runFailover } from "../../../src/core/extensions/builtin/anthropic-subscription/failover.ts";

const PROVIDER = "anthropic-subscription";
const T0 = Date.UTC(2026, 9, 16, 12, 0, 0);

function pool(tag: string): [AccountSlot, AccountSlot] {
	return [
		{ name: `shared-${tag}`, refresh: "r-1", access: "a-1", expires: 1, source: "login" },
		{ name: `spare-${tag}`, refresh: "r-2", access: "a-2", expires: 1, source: "login" },
	];
}

async function storeWith(accounts: AccountSlot[]): Promise<CredentialStore> {
	const store = new InMemoryCredentialStore();
	await store.modify(PROVIDER, async () =>
		accounts.reduce<AnthropicSubscriptionCredential>(
			(credential, account) => addAccount(credential, account),
			emptyCredential(),
		),
	);
	return store;
}

async function stored(store: CredentialStore): Promise<AccountSlot[]> {
	return ((await store.read(PROVIDER)) as AnthropicSubscriptionCredential).accounts ?? [];
}

/** One turn of `session`, pinned to the shared account; `failure` is what the shared account answers. */
async function turn(
	store: CredentialStore,
	session: string,
	home: string,
	failure: string | undefined,
	now = T0,
): Promise<string[]> {
	const attempts: string[] = [];
	const stream = runFailover<{ type: "done" }>({
		accounts: await stored(store),
		selectFn: (accounts) =>
			selectAccount(accounts, { sessionId: session, pinnedAccount: home, now, model: "claude-fable-5" }),
		runAttempt: async function* (slot) {
			attempts.push(slot.name);
			if (slot.name === home && failure !== undefined) throw new Error(failure);
			yield { type: "done" };
		},
		classify: classifySdkError,
		store,
		providerId: PROVIDER,
		model: "claude-fable-5",
		now: () => now,
		sleep: async () => {},
		sessionKey: session,
	});
	for await (const _event of stream) {
		// drained
	}
	return attempts;
}

describe("senpi#3466 only a confirmed account-level limit moves other sessions", () => {
	it.each([
		["a 429 rate limit", "rate", "HTTP 429 too many requests"],
		["a one-model limit", "fable", "You've hit your Fable limit \u00b7 resets 1pm (UTC)"],
		["a refill breaker", "breaker", "rapid_refill_breaker"],
	])("%s moves only the session that hit it", async (_label, tag, failure) => {
		// given two sessions on the same account, and session A hits the failure
		const [shared, spare] = pool(tag);
		const store = await storeWith([shared, spare]);
		expect(await turn(store, `a-${tag}`, shared.name, failure)).toEqual([shared.name, spare.name]);

		// then nothing is written to the shared record, so session B keeps the account
		expect((await stored(store)).every((account) => account.blockedUntil === undefined && !account.modelBlocks)).toBe(
			true,
		);
		expect(await turn(store, `b-${tag}`, shared.name, undefined, T0 + 1_000)).toEqual([shared.name]);

		// and session A remembers its own block on its next turn instead of retrying the account
		expect(await turn(store, `a-${tag}`, shared.name, failure, T0 + 2_000)).toEqual([spare.name]);
	});

	it("a 529 overload moves no session at all", async () => {
		const [shared, spare] = pool("overload");
		const store = await storeWith([shared, spare]);
		await turn(store, "session-a", shared.name, "HTTP 529 overloaded").catch(() => undefined);
		expect(await turn(store, "session-b", shared.name, undefined, T0 + 1_000)).toEqual([shared.name]);
		expect(await turn(store, "session-a", shared.name, undefined, T0 + 2_000)).toEqual([shared.name]);
	});

	it("a confirmed account usage limit moves every session off the spent account", async () => {
		// given session A's account reports its 5-hour limit is spent
		const [shared, spare] = pool("spent");
		const store = await storeWith([shared, spare]);
		await turn(store, "session-a", shared.name, "You've hit your 5-hour limit \u00b7 resets in 1 hour");

		// then the shared record holds the block, and session B goes straight to the spare account
		expect((await stored(store)).find((account) => account.name === shared.name)?.blockedUntil).toBe(T0 + 3_600_000);
		expect(await turn(store, "session-b", shared.name, undefined, T0 + 1_000)).toEqual([spare.name]);
	});
});
