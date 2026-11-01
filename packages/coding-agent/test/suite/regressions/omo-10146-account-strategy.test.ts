import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamWithCredentialRotation } from "../../../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";
import type { AccountSlot } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	rendezvousOrder,
	selectAccount,
} from "../../../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import { loadAnthropicSubscriptionProviderSettings } from "../../../src/core/extensions/builtin/anthropic-subscription/settings.ts";
import { ModelConfig } from "../../../src/core/model-config.ts";
import { InMemorySettingsStorage, SettingsManager } from "../../../src/core/settings-manager.ts";
import { subscriptionLimits } from "../../../src/core/subscription-limits/limit-store.ts";
import { cliSlot } from "../../support/claude-cli-test-slots.ts";

// omo#10146: account strategy changes new-session distribution, not a session's cache locality.
type Strategy = "cache-affine" | "fill-first" | "round-robin";
const NOW = Date.parse("2026-10-30T00:00:00Z");
const names = ["alpha", "beta", "gamma"];
const accounts: AccountSlot[] = names.map((name) => cliSlot(name));
let directory: string;
let repository: CredentialSlotRepository;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	directory = mkdtempSync(join(process.cwd(), ".strategy-test-"));
	repository = new CredentialSlotRepository(join(directory, "state.json"));
	vi.spyOn(subscriptionLimits, "snapshot").mockReturnValue([]);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	rmSync(directory, { recursive: true, force: true });
});

function settings(global: unknown, project: unknown = {}): SettingsManager {
	const storage = new InMemorySettingsStorage();
	storage.withLock("global", () => JSON.stringify({ anthropicSubscriptionProvider: global }));
	storage.withLock("project", () => JSON.stringify({ anthropicSubscriptionProvider: project }));
	return SettingsManager.fromStorage(storage);
}

describe("account strategy settings", () => {
	it.each(["cache-affine", "fill-first", "round-robin"])("loads the %s Claude strategy", (accountStrategy) => {
		expect(loadAnthropicSubscriptionProviderSettings(settings({ accountStrategy }), {})).toMatchObject({
			accountStrategy,
		});
	});

	it("lets project strategy override the global strategy", () => {
		expect(
			loadAnthropicSubscriptionProviderSettings(
				settings({ accountStrategy: "fill-first" }, { accountStrategy: "round-robin" }),
				{},
			),
		).toMatchObject({ accountStrategy: "round-robin" });
	});

	it.each(["random", null, 7])("rejects invalid Claude strategy %s with its field name", (accountStrategy) => {
		expect(() => loadAnthropicSubscriptionProviderSettings(settings({ accountStrategy }), {})).toThrow(
			"anthropicSubscriptionProvider.accountStrategy",
		);
	});

	it.each(["cache-affine", "fill-first", "round-robin"])("loads the %s generic policy", (accountStrategy) => {
		expect(
			ModelConfig.validationError(
				JSON.stringify({ providers: { example: { credentials: { accountStrategy } } } }),
				"models.json",
			),
		).toBeUndefined();
	});

	it.each(["random", null, 7])("names the invalid generic policy field for %s", (accountStrategy) => {
		expect(
			ModelConfig.validationError(
				JSON.stringify({ providers: { example: { credentials: { accountStrategy } } } }),
				"models.json",
			),
		).toContain("accountStrategy");
	});
});

describe.each(["generic", "claude"] as const)("%s account strategies", (lane) => {
	const provider = lane === "generic" ? "strategy-test" : "anthropic-subscription";

	async function choose(
		key: string,
		accountStrategy?: Strategy,
		options: { order?: string[]; pinned?: string; blocked?: string; affinity?: boolean } = {},
	): Promise<string | undefined> {
		if (lane === "claude") {
			return selectAccount(
				accounts.map((account) =>
					account.name === options.blocked
						? { ...account, blockedUntil: NOW + 60_000, blockReason: "rate_limit" }
						: account,
				),
				{
					sessionId: key,
					accountStrategy,
					accountOrder: options.order,
					pinnedAccount: options.pinned,
				},
			).name;
		}
		const credential: PooledCredential = {
			type: "api_key",
			key: "synthetic-alpha",
			accounts: names.map((name) => ({ name, key: `synthetic-${name}`, source: "login" })),
			...(options.order === undefined ? {} : { order: options.order }),
			...(options.pinned === undefined ? {} : { pinned: options.pinned }),
		};
		if (options.blocked !== undefined) {
			const name = options.blocked;
			const credentialRevision = await repository.storedCredentialRevision(provider, name, {
				key: `synthetic-${name}`,
			});
			await repository.mutateSlotState(provider, "stored", name, () => ({
				blockReason: "rate_limit",
				blockedUntil: NOW + 60_000,
				credentialRevision,
			}));
		}
		let selected: string | undefined;
		for await (const _event of streamWithCredentialRotation({
			sources: {
				providerId: provider,
				credential,
				env: () => undefined,
				repository,
				policy: { accountStrategy, affinity: options.affinity },
			},
			affinityKey: key,
			runAttempt: async function* (slot) {
				selected = slot.name;
				yield* [];
			},
		})) {
			// The real selector is observed without a provider request.
		}
		return selected;
	}

	it("keeps the exact HRW default and explicit cache-affine choices", async () => {
		for (const key of ["default-a", "default-b", "default-c"]) {
			const expected = rendezvousOrder(key, accounts)[0]?.name;
			expect(await choose(key)).toBe(expected);
			expect(await choose(key, "cache-affine")).toBe(expected);
		}
	});

	it("fills the first stored account even when HRW ranks another first", async () => {
		const key = Array.from({ length: 20 }, (_, index) => `fill-${index}`).find(
			(candidate) => rendezvousOrder(candidate, accounts)[0]?.name !== "alpha",
		);
		if (key === undefined) throw new Error("fixture needs a non-alpha HRW winner");
		expect(await choose(key, "fill-first")).toBe("alpha");
	});

	it("uses the user's order for fill-first and skips a blocked first account", async () => {
		expect(await choose("fill-ordered", "fill-first", { order: ["gamma", "beta"], blocked: "gamma" })).toBe("beta");
	});

	it("gives consecutive new sessions consecutive accounts and retains their choices", async () => {
		const keys = ["rr-new-a", "rr-new-b", "rr-new-c", "rr-new-d"];
		const chosen = [];
		for (const key of keys) {
			// Each runtime owns a repository object, so its identity must not restart the provider's cursor.
			if (lane === "generic") repository = new CredentialSlotRepository(join(directory, `${key}.json`));
			chosen.push(await choose(key, "round-robin"));
		}
		expect(new Set(chosen.slice(0, 3)).size).toBe(3);
		const start = names.indexOf(chosen[0] ?? "");
		expect(chosen).toEqual(keys.map((_, index) => names[(start + index) % names.length]));
		expect(chosen[3]).toBe(chosen[0]);
		for (const [index, key] of keys.entries()) {
			if (lane === "generic") repository = new CredentialSlotRepository(join(directory, `${key}.json`));
			expect(await choose(key, "round-robin")).toBe(chosen[index]);
		}
	});

	it("rotates round-robin through the user's stored order", async () => {
		const order = ["gamma", "alpha", "beta"];
		const chosen = [];
		for (const key of ["rr-order-a", "rr-order-b", "rr-order-c"]) {
			chosen.push(await choose(key, "round-robin", { order }));
		}
		const start = order.indexOf(chosen[0] ?? "");
		expect(chosen).toEqual(order.map((_, index) => order[(start + index) % order.length]));
	});

	it("retains a round-robin replacement after a block", async () => {
		const first = await choose("rr-block", "round-robin");
		const replacement = await choose("rr-block", "round-robin", { blocked: first });
		expect(replacement).not.toBe(first);
		if (lane === "generic" && first !== undefined) {
			await repository.mutateSlotState(provider, "stored", first, () => undefined);
		}
		expect(await choose("rr-block", "round-robin")).toBe(replacement);
	});

	it.each(["cache-affine", "fill-first", "round-robin"] as const)(
		"applies headroom preference and honors pins under %s",
		async (strategy) => {
			vi.spyOn(subscriptionLimits, "snapshot").mockReturnValue(
				["alpha", "beta"].map((account) => ({
					provider,
					account,
					windows: [{ id: "quota", label: "5h", usedPercent: 95 }],
					reportedAt: new Date(NOW).toISOString(),
				})),
			);
			expect(await choose(`headroom-${strategy}`, strategy, { order: names })).toBe("gamma");
			expect(await choose(`pinned-${strategy}`, strategy, { order: names, pinned: "alpha" })).toBe("alpha");
		},
	);

	it.each(["cache-affine", "fill-first", "round-robin"] as const)(
		"keeps serving when every account is near its limit under %s",
		async (strategy) => {
			vi.spyOn(subscriptionLimits, "snapshot").mockReturnValue(
				names.map((account) => ({
					provider,
					account,
					windows: [{ id: "quota", label: "5h", usedPercent: 100 }],
					reportedAt: new Date(NOW).toISOString(),
				})),
			);
			expect(names).toContain(await choose(`all-near-${strategy}`, strategy));
		},
	);

	it("keeps a round-robin headroom replacement after the original resets", async () => {
		const first = await choose("rr-headroom", "round-robin");
		vi.spyOn(subscriptionLimits, "snapshot").mockReturnValue([
			{
				provider,
				account: first ?? "missing",
				windows: [{ id: "quota", label: "5h", usedPercent: 100 }],
				reportedAt: new Date(NOW).toISOString(),
			},
		]);
		const replacement = await choose("rr-headroom", "round-robin");
		expect(replacement).not.toBe(first);
		vi.spyOn(subscriptionLimits, "snapshot").mockReturnValue([]);
		expect(await choose("rr-headroom", "round-robin")).toBe(replacement);
	});

	if (lane === "generic") {
		it("preserves legacy affinity false unless a strategy is explicit", async () => {
			const key = Array.from({ length: 20 }, (_, index) => `legacy-${index}`).find(
				(candidate) => rendezvousOrder(candidate, accounts)[0]?.name !== "alpha",
			);
			if (key === undefined) throw new Error("fixture needs a non-alpha HRW winner");
			expect(await choose(key, undefined, { affinity: false })).toBe("alpha");
			expect(await choose(key, "cache-affine", { affinity: false })).toBe(rendezvousOrder(key, accounts)[0]?.name);
		});
	} else {
		it.each(["cache-affine", "fill-first", "round-robin"] as const)(
			"preserves resident account and disabled fallback under %s",
			(accountStrategy) => {
				const options = {
					accountStrategy,
					sessionId: `resident-${accountStrategy}`,
					preferredAccount: "beta",
					accountFallback: false,
				};
				expect(selectAccount(accounts, options).name).toBe("beta");
				expect(() =>
					selectAccount(
						accounts.map((account) =>
							account.name === "beta" ? { ...account, blockedUntil: NOW + 60_000 } : account,
						),
						options,
					),
				).toThrow("All Anthropic Subscription accounts are blocked");
			},
		);
	}
});
