import type { OAuthAuth } from "@earendil-works/pi-ai";
import { appendLoginSlot } from "@earendil-works/pi-ai/auth/pool/slots";
import { describe, expect, it } from "vitest";
import {
	type AccountSlot,
	type AnthropicSubscriptionCredential,
	emptyCredential,
	listAccounts,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { createOAuthConfig } from "../../../src/core/extensions/builtin/anthropic-subscription/oauth-login.ts";

// senpi#3928: Add account with the account the pool already holds must be refused,
// not stored as a duplicate; a different account must always add a slot.
const ACCOUNT_A = { id: "acct-a/org-1", email: "a@example.com" };
const ACCOUNT_B = { id: "acct-b/org-2", email: "b@example.com" };

// Each login's grant expires strictly later than the previous one, as a real later login does;
// the persistence merge refreshes a same-name slot only on strictly newer material.
let loginSequence = 0;

function fakeExchange(identity: { id: string; email?: string } | undefined, tag: string): OAuthAuth {
	loginSequence++;
	const expires = Date.now() + 3_600_000 + loginSequence * 60_000;
	return {
		name: "fake",
		async login() {
			return {
				type: "oauth",
				access: `${tag}-access`,
				refresh: `${tag}-refresh`,
				expires,
				...(identity ? { identity } : {}),
			};
		},
		async refresh(current) {
			return current;
		},
		async toAuth(current) {
			return { apiKey: current.access };
		},
	};
}

/** One Add account round trip the way Models.login persists it: provider login, then appendLoginSlot. */
async function addAccount(
	stored: AnthropicSubscriptionCredential,
	flow: OAuthAuth,
	answer: string | undefined,
): Promise<AnthropicSubscriptionCredential> {
	const config = createOAuthConfig({ readCurrent: async () => stored, loginFlow: flow });
	const result = await config.login(answer === undefined ? {} : { onPrompt: async () => answer });
	return appendLoginSlot(stored, result as AnthropicSubscriptionCredential) as AnthropicSubscriptionCredential;
}

const names = (credential: AnthropicSubscriptionCredential) => listAccounts(credential).map((slot) => slot.name);

describe("Claude Add account tells accounts apart by identity (senpi#3928)", () => {
	it("A then B gives two slots, each its own account; A again is refused and nothing is written", async () => {
		let pool = await addAccount(emptyCredential(), fakeExchange(ACCOUNT_A, "a1"), "");
		pool = await addAccount(pool, fakeExchange(ACCOUNT_B, "b1"), "account-2");
		expect(names(pool)).toEqual(["default", "account-2"]);
		const [first, second] = listAccounts(pool) as [AccountSlot, AccountSlot];
		expect([first.access, first.identity?.id]).toEqual(["a1-access", ACCOUNT_A.id]);
		expect([second.access, second.identity?.id]).toEqual(["b1-access", ACCOUNT_B.id]);

		const before = structuredClone(pool);
		await expect(addAccount(pool, fakeExchange(ACCOUNT_A, "a2"), "account-3")).rejects.toThrow(
			"That Claude account is already connected as 'default'",
		);
		expect(pool).toEqual(before);
	});

	it("the same account is refused on a headless add too, when its slot is healthy and not the target", async () => {
		const pool = await addAccount(emptyCredential(), fakeExchange(ACCOUNT_A, "a1"), "");
		const withB = await addAccount(pool, fakeExchange(ACCOUNT_B, "b1"), undefined);
		expect(names(withB)).toEqual(["default", "account-2"]);
		await expect(addAccount(withB, fakeExchange(ACCOUNT_B, "b2"), undefined)).rejects.toThrow(
			"That Claude account is already connected as 'account-2'",
		);
	});

	it("a login that targets the same account's slot refreshes it in place (Reconnect)", async () => {
		let pool = await addAccount(emptyCredential(), fakeExchange(ACCOUNT_A, "a1"), "");
		pool = await addAccount(pool, fakeExchange(ACCOUNT_B, "b1"), "account-2");
		pool = await addAccount(pool, fakeExchange(ACCOUNT_A, "a2"), "default");
		expect(names(pool)).toEqual(["default", "account-2"]);
		expect(listAccounts(pool)[0]?.access).toBe("a2-access");
		expect(listAccounts(pool)[1]?.access).toBe("b1-access");
	});

	it("a same-account login recovers that account's auth block wherever it sits", async () => {
		let pool = await addAccount(emptyCredential(), fakeExchange(ACCOUNT_A, "a1"), "");
		pool = await addAccount(pool, fakeExchange(ACCOUNT_B, "b1"), "account-2");
		pool = {
			...pool,
			accounts: pool.accounts?.map((slot) =>
				slot.name === "default"
					? { ...slot, blockReason: "auth_error", blockedUntil: Date.now() + 60_000, expires: Date.now() - 1 }
					: slot,
			),
		};
		pool = await addAccount(pool, fakeExchange(ACCOUNT_A, "a2"), "account-3");
		expect(names(pool)).toEqual(["default", "account-2"]);
		expect(listAccounts(pool)[0]?.access).toBe("a2-access");
		expect(listAccounts(pool)[0]?.blockReason).toBeUndefined();
	});

	it("a different account never overwrites a lone account known to be someone else", async () => {
		const pool = await addAccount(emptyCredential(), fakeExchange(ACCOUNT_A, "a1"), "");
		for (const answer of ["", undefined]) {
			const next = await addAccount(pool, fakeExchange(ACCOUNT_B, "b1"), answer);
			expect(names(next)).toEqual(["default", "account-2"]);
			expect(listAccounts(next)[0]?.access).toBe("a1-access");
		}
	});
});
