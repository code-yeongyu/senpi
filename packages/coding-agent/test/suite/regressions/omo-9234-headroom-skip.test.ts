import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamWithCredentialRotation } from "../../../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";
import type { AccountSlot } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { selectAccount } from "../../../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import { subscriptionLimits } from "../../../src/core/subscription-limits/limit-store.ts";
import type { LimitWindow } from "../../../src/core/subscription-limits/limit-windows.ts";
import { cliSlot } from "../../support/claude-cli-test-slots.ts";

// omo#9234: both account-selection owners prefer live subscription headroom.
const NOW = Date.parse("2026-10-30T00:00:00Z");
const names = ["alpha", "beta"];
const accounts: AccountSlot[] = names.map((name) => cliSlot(name));
let directory: string;
let repository: CredentialSlotRepository;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	directory = mkdtempSync(join(process.cwd(), ".headroom-test-"));
	repository = new CredentialSlotRepository(join(directory, "state.json"));
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	rmSync(directory, { recursive: true, force: true });
});

function report(provider: string, windows: readonly LimitWindow[], all = false): void {
	vi.spyOn(subscriptionLimits, "snapshot").mockReturnValue(
		(all ? names : ["alpha"]).map((account) => ({
			provider,
			account,
			windows,
			reportedAt: new Date(NOW).toISOString(),
		})),
	);
}

async function generic(pinned = false): Promise<string | undefined> {
	const credential: PooledCredential = {
		type: "api_key",
		key: "synthetic-alpha",
		accounts: names.map((name) => ({ name, key: `synthetic-${name}`, source: "login" })),
		order: names,
		...(pinned ? { pinned: "alpha" } : {}),
	};
	let selected: string | undefined;
	for await (const _event of streamWithCredentialRotation({
		sources: { providerId: "chatgpt-subscription", credential, env: () => undefined, repository },
		affinityKey: "headroom-session",
		runAttempt: async function* (slot) {
			selected = slot.name;
			yield* [];
		},
	})) {
		// No provider or network is needed to observe the selected account.
	}
	return selected;
}

describe.each(["generic", "claude"] as const)("%s subscription headroom", (lane) => {
	const provider = lane === "generic" ? "chatgpt-subscription" : "anthropic-subscription";
	const choose = (pinned = false) =>
		lane === "generic"
			? generic(pinned)
			: selectAccount(accounts, {
					accountOrder: names,
					preferredAccount: "alpha",
					...(pinned ? { pinnedAccount: "alpha" } : {}),
				}).name;

	it.each([95, 100])("skips an account at %s percent before requesting", async (usedPercent) => {
		// Given a live reported window on the current account.
		report(provider, [{ id: "quota", label: "5h", usedPercent, resetsAt: new Date(NOW + 60_000).toISOString() }]);
		// When the next request selects an account, then it uses the next account.
		expect(await choose()).toBe("beta");
	});

	it("keeps an account below the threshold", async () => {
		report(provider, [{ id: "quota", label: "5h", usedPercent: 94.99 }]);
		expect(await choose()).toBe("alpha");
	});

	it("ignores a window whose reset time passed", async () => {
		report(provider, [{ id: "quota", label: "5h", usedPercent: 100, resetsAt: new Date(NOW).toISOString() }]);
		expect(await choose()).toBe("alpha");
	});

	it("keeps the current choice when every account is near its limit", async () => {
		report(provider, [{ id: "quota", label: "5h", usedPercent: 99 }], true);
		expect(await choose()).toBe("alpha");
	});

	it("honors a pin even above the threshold", async () => {
		report(provider, [{ id: "quota", label: "5h", usedPercent: 100 }]);
		expect(await choose(true)).toBe("alpha");
	});

	it("keeps the current choice without reported usage", async () => {
		report(provider, []);
		expect(await choose()).toBe("alpha");
	});

	it("does not use another provider's limits", async () => {
		report("other-provider", [{ id: "quota", label: "5h", usedPercent: 100 }]);
		expect(await choose()).toBe("alpha");
	});

	it("skips when any live window reaches the threshold", async () => {
		report(provider, [
			{ id: "short", label: "5h", usedPercent: 20 },
			{ id: "weekly", label: "7d", usedPercent: 95 },
		]);
		expect(await choose()).toBe("beta");
	});

	it("ignores an exhausted expired window beside a healthy live window", async () => {
		report(provider, [
			{ id: "short", label: "5h", usedPercent: 100, resetsAt: new Date(NOW - 1).toISOString() },
			{ id: "weekly", label: "7d", usedPercent: 20 },
		]);
		expect(await choose()).toBe("alpha");
	});
});

it("keeps a generic session on its replacement after the original account resets", async () => {
	report("chatgpt-subscription", [{ id: "quota", label: "5h", usedPercent: 95 }]);
	expect(await generic()).toBe("beta");
	report("chatgpt-subscription", [{ id: "quota", label: "5h", usedPercent: 0 }]);
	expect(await generic()).toBe("beta");
});

it("keeps Claude on its resident replacement when the original account resets", () => {
	report("anthropic-subscription", [{ id: "quota", label: "5h", usedPercent: 0 }]);
	expect(selectAccount(accounts, { accountOrder: names, preferredAccount: "beta" }).name).toBe("beta");
});

it("does not replace a near-limit Claude account with a blocked account", () => {
	report("anthropic-subscription", [{ id: "quota", label: "5h", usedPercent: 95 }]);
	const blocked = accounts.map((account) =>
		account.name === "beta" ? { ...account, blockedUntil: NOW + 60_000, blockReason: "rate_limit" } : account,
	);
	expect(selectAccount(blocked, { accountOrder: names, preferredAccount: "alpha" }).name).toBe("alpha");
});

it("keeps the selected Claude account when account fallback is explicitly disabled", () => {
	report("anthropic-subscription", [{ id: "quota", label: "5h", usedPercent: 95 }]);
	expect(selectAccount(accounts, { accountOrder: names, accountFallback: false }).name).toBe("alpha");
});
