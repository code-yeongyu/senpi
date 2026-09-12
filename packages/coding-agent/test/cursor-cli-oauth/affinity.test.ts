import { describe, expect, it } from "vitest";
import type { AccountSlot } from "../../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";
import { rendezvousOrder as claudeRendezvousOrder } from "../../src/core/extensions/builtin/claude-sdk-oauth/affinity.ts";
import {
	AllCursorAccountsBlockedError,
	type CursorAffinityAccountSlot,
	clearExpiredBlocks,
	rendezvousOrder,
	selectAccount,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/affinity.ts";

type TestAccount = CursorAffinityAccountSlot & {
	access: string;
	refresh: string;
	expires: number;
	source: "login";
};

const accounts: TestAccount[] = [
	{ name: "alpha", refresh: "", access: "", expires: 0, source: "login" },
	{ name: "bravo", refresh: "", access: "", expires: 0, source: "login" },
	{ name: "charlie", refresh: "", access: "", expires: 0, source: "login" },
];

const sessionIds = ["session-01", "session-02", "session-03", "session-04", "session-05", "session-06"];

describe("Cursor CLI OAuth account affinity", () => {
	it("keeps a stable HRW order for a fixed session key", () => {
		const expected = ["alpha", "charlie", "bravo"];
		expect(rendezvousOrder("session-01", accounts).map((account) => account.name)).toEqual(expected);
		expect(rendezvousOrder("session-01", accounts).map((account) => account.name)).toEqual(expected);
	});

	it("pins ordering semantics to the Claude OAuth implementation", () => {
		for (const sessionId of sessionIds) {
			const cursorOrder = rendezvousOrder(sessionId, accounts).map((account) => account.name);
			const claudeOrder = claudeRendezvousOrder(sessionId, accounts as AccountSlot[]).map((account) => account.name);
			expect(cursorOrder).toEqual(claudeOrder);
		}
	});

	it("only moves sessions that rendezvous with a newly added slot", () => {
		const delta: TestAccount = { name: "delta", refresh: "", access: "", expires: 0, source: "login" };
		const expanded = [...accounts, delta];
		const reassigned = sessionIds.filter(
			(sessionId) => selectAccount(accounts, { sessionId }).name !== selectAccount(expanded, { sessionId }).name,
		);

		expect(reassigned).toEqual(["session-05"]);
		for (const sessionId of reassigned) {
			expect(selectAccount(expanded, { sessionId }).name).toBe("delta");
		}
	});

	it("uses an available pin before the HRW winner", () => {
		expect(selectAccount(accounts, { sessionId: "session-01", pinnedAccount: "charlie" }).name).toBe("charlie");
	});

	it("falls through to the HRW order when the pin is blocked or undefined", () => {
		const blockedPin = accounts.map((account) =>
			account.name === "charlie"
				? { ...account, blockedUntil: 10_000, blockReason: "rate_limit" as const }
				: account,
		);

		expect(selectAccount(blockedPin, { sessionId: "session-01", pinnedAccount: "charlie", now: 1_000 }).name).toBe(
			"alpha",
		);
		expect(selectAccount(accounts, { sessionId: "session-01", pinnedAccount: undefined }).name).toBe("alpha");
	});

	it("clears elapsed rate-limit blocks but retains auth errors until re-login", () => {
		const cleared = clearExpiredBlocks(
			[
				{ ...accounts[0]!, blockedUntil: 999, blockReason: "rate_limit" },
				{ ...accounts[1]!, blockedUntil: 999, blockReason: "auth_error" },
			],
			1_000,
		);

		expect(cleared[0]).not.toHaveProperty("blockedUntil");
		expect(cleared[0]).not.toHaveProperty("blockReason");
		expect(cleared[1]).toMatchObject({ blockedUntil: 999, blockReason: "auth_error" });
	});

	it("retries once against a block that expires during selection", () => {
		let reads = 0;
		const expiring: TestAccount = {
			...accounts[0]!,
			blockReason: "rate_limit",
			get blockedUntil() {
				reads += 1;
				return reads <= 2 ? 1_001 : 999;
			},
		};

		const selected = selectAccount([expiring], { sessionId: "stale", now: 1_000 });
		expect(selected.name).toBe("alpha");
		expect(selected).not.toHaveProperty("blockedUntil");
		expect(selected).not.toHaveProperty("blockReason");
	});

	it("throws a typed error with the soonest unblock time when every slot is blocked", () => {
		const blocked = [
			{ ...accounts[0]!, blockedUntil: 9_000, blockReason: "rate_limit" },
			{ ...accounts[1]!, blockedUntil: 4_000, blockReason: "rate_limit" },
			{ ...accounts[2]!, blockReason: "auth_error" },
		];

		expect(() => selectAccount(blocked, { sessionId: "blocked", now: 1_000 })).toThrow(AllCursorAccountsBlockedError);
		try {
			selectAccount(blocked, { sessionId: "blocked", now: 1_000 });
		} catch (error) {
			expect(error).toBeInstanceOf(AllCursorAccountsBlockedError);
			expect((error as AllCursorAccountsBlockedError).soonestUnblockAt).toBe(4_000);
		}
	});

	it("reports no unblock time for an empty or permanently auth-blocked pool", () => {
		for (const pool of [[], accounts.map((account) => ({ ...account, blockReason: "auth_error" as const }))]) {
			try {
				selectAccount(pool, { sessionId: "none", now: Number.MAX_SAFE_INTEGER });
				expect.unreachable("selection should throw");
			} catch (error) {
				expect(error).toBeInstanceOf(AllCursorAccountsBlockedError);
				expect((error as AllCursorAccountsBlockedError).soonestUnblockAt).toBeUndefined();
			}
		}
	});
});
