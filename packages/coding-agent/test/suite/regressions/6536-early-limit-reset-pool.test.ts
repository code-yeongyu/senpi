import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { getCredentialAccounts } from "../../../src/core/credential-accounts.ts";
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
import { runFailover } from "../../../src/core/extensions/builtin/anthropic-subscription/failover.ts";
import { subscriptionLimits } from "../../../src/core/subscription-limits/limit-store.ts";
import { cliSlot } from "../../support/claude-cli-test-slots.ts";

// senpi#6536: every pooled Claude account is blocked until the reset its limit stated; the user then resets one
// account's usage early. The account's usage, read after the block, shows it under every limit, so the pool must
// use it now instead of refusing until the stated reset.
const HOUR = 60 * 60_000;
const BLOCKED_AT = Date.UTC(2026, 10, 12, 3, 0);
const NOW = BLOCKED_AT + 20 * 60_000;
const STATED_RESET = BLOCKED_AT + 5 * HOUR;

function heldAccount(name: string): AccountSlot {
	return cliSlot(name, { blockReason: "rate_limit", blockedUntil: STATED_RESET, blockedAt: BLOCKED_AT });
}

function reportUsage(account: string, usedPercent: number, at: number): void {
	subscriptionLimits.report("anthropic-subscription", account, {
		windows: [
			{
				id: "claude:5h",
				label: "5h",
				windowMinutes: 300,
				usedPercent,
				resetsAt: new Date(STATED_RESET).toISOString(),
			},
		],
		reportedAt: new Date(at),
	});
}

async function runPool(accounts: readonly AccountSlot[]): Promise<{ attempts: string[]; outcome: unknown }> {
	const store = new InMemoryCredentialStore();
	await store.modify("anthropic-subscription", async () =>
		accounts.reduce<AnthropicSubscriptionCredential>(
			(credential, slot) => addAccount(credential, slot),
			emptyCredential(),
		),
	);
	const attempts: string[] = [];
	try {
		for await (const _event of runFailover({
			accounts,
			selectFn: (pool) => selectAccount(pool, { sessionId: "6536", now: NOW }),
			runAttempt: async function* (slot) {
				attempts.push(slot.name);
				yield { type: "done", value: slot.name };
			},
			classify: classifySdkError,
			store,
			providerId: "anthropic-subscription",
			now: () => NOW,
		}));
		return { attempts, outcome: "served" };
	} catch (error) {
		return { attempts, outcome: error };
	}
}

describe("a pooled account whose limit was reset early serves before its stated reset (senpi#6536)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("runs the turn on the account whose usage, read after the block, is under its limits", async () => {
		reportUsage("pool-reset-b", 0, BLOCKED_AT + 5 * 60_000);

		const { attempts, outcome } = await runPool([heldAccount("pool-reset-a"), heldAccount("pool-reset-b")]);

		expect(outcome).toBe("served");
		expect(attempts).toEqual(["pool-reset-b"]);
	});

	it("keeps refusing when the only usage reading predates the block or still shows the limit", async () => {
		reportUsage("pool-stale-a", 0, BLOCKED_AT - 60_000);
		reportUsage("pool-stale-b", 100, BLOCKED_AT + 5 * 60_000);

		const { attempts, outcome } = await runPool([heldAccount("pool-stale-a"), heldAccount("pool-stale-b")]);

		expect(outcome).toBeInstanceOf(AllAccountsBlockedError);
		expect(attempts).toEqual([]);
	});

	it("lists the early-reset account as able to serve, so the session's provider hold is released", async () => {
		reportUsage("list-reset-b", 0, BLOCKED_AT + 5 * 60_000);
		const credential = [
			heldAccount("list-reset-a"),
			heldAccount("list-reset-b"),
		].reduce<AnthropicSubscriptionCredential>((current, slot) => addAccount(current, slot), emptyCredential());
		const storage = AuthStorage.inMemory({ "anthropic-subscription": credential });
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);

		const accounts = await getCredentialAccounts(storage, "anthropic-subscription", {});

		expect(accounts.map((account) => [account.name, account.blocked])).toEqual([
			["list-reset-a", true],
			["list-reset-b", false],
		]);
	});
});
