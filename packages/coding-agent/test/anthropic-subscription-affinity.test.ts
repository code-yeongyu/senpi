import { describe, expect, it } from "vitest";
import type { AccountSlot } from "../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	AllAccountsBlockedError,
	DEFAULT_AFFINITY_KEY,
	getAffinityKey,
	rendezvousOrder,
	selectAccount,
} from "../src/core/extensions/builtin/anthropic-subscription/affinity.ts";

const accounts: AccountSlot[] = [
	{ name: "alpha", refresh: "", access: "", expires: 0, source: "login" },
	{ name: "bravo", refresh: "", access: "", expires: 0, source: "login" },
	{ name: "charlie", refresh: "", access: "", expires: 0, source: "login" },
];

const goldenSessionIds = ["session-01", "session-02", "session-03", "session-04", "session-05", "session-06"];

describe("Claude SDK OAuth account affinity", () => {
	it("uses a stable default affinity key and prefers an explicit originating key", () => {
		expect(getAffinityKey({})).toBe(DEFAULT_AFFINITY_KEY);
		expect(getAffinityKey({ sessionId: "session", affinityKey: "parent" })).toBe("parent");
		expect(getAffinityKey({ sessionId: "session" })).toBe("session");
	});

	it("selects the exact HRW winner for the golden sessions", () => {
		expect(goldenSessionIds.map((sessionId) => selectAccount(accounts, { sessionId }).name)).toEqual([
			"alpha",
			"alpha",
			"alpha",
			"alpha",
			"bravo",
			"bravo",
		]);
	});

	it("has the exact minimal-disruption reassignment set when the pool changes", () => {
		const expanded = [...accounts, { name: "delta", refresh: "", access: "", expires: 0, source: "login" as const }];
		const reassigned = goldenSessionIds.filter(
			(sessionId) => selectAccount(accounts, { sessionId }).name !== selectAccount(expanded, { sessionId }).name,
		);
		expect(reassigned).toEqual(["session-05"]);
	});

	it("keeps ancillary calls on the parent session's account without cross-session state", () => {
		const parent = selectAccount(accounts, { sessionId: "parent-session" }).name;
		expect(selectAccount(accounts, { sessionId: "isolated-summary", affinityKey: "parent-session" }).name).toBe(
			parent,
		);

		const sessionA = rendezvousOrder("interleaved-a", accounts).map((account) => account.name);
		const sessionB = rendezvousOrder("interleaved-b", accounts).map((account) => account.name);
		for (let index = 0; index < 4; index++) {
			expect(rendezvousOrder("interleaved-a", accounts).map((account) => account.name)).toEqual(sessionA);
			expect(rendezvousOrder("interleaved-b", accounts).map((account) => account.name)).toEqual(sessionB);
		}
	});

	it("uses a pin while it remains available, then walks unblocked HRW accounts", () => {
		expect(selectAccount(accounts, { sessionId: "session-01", pinnedAccount: "charlie" }).name).toBe("charlie");
		const first = rendezvousOrder("session-01", accounts)[0]!;
		const next = selectAccount(
			accounts.map((account) =>
				account.name === first.name ? { ...account, blockedUntil: 10_000, blockReason: "rate_limit" } : account,
			),
			{ sessionId: "session-01", now: 1_000 },
		);
		expect(next.name).toBe(rendezvousOrder("session-01", accounts)[1]!.name);
	});

	it("raises a typed all-blocked error and never auto-expires auth failures", () => {
		const blocked = accounts.map((account) => ({ ...account, blockedUntil: 10_000, blockReason: "rate_limit" }));
		expect(() => selectAccount(blocked, { sessionId: "blocked", now: 1_000 })).toThrow(AllAccountsBlockedError);
		try {
			selectAccount(blocked, { sessionId: "blocked", now: 1_000 });
		} catch (error) {
			expect(error).toBeInstanceOf(AllAccountsBlockedError);
			expect((error as AllAccountsBlockedError).soonestUnblockAt).toBe(10_000);
		}

		const authBlocked = accounts.map((account) => ({ ...account, blockReason: "auth_error" }));
		expect(() => selectAccount(authBlocked, { sessionId: "auth", now: Number.MAX_SAFE_INTEGER })).toThrow(
			AllAccountsBlockedError,
		);
	});
});
