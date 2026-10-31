import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	type CredentialAccountSummary,
	getCredentialAccounts,
	pinCredentialAccount,
	removeCredentialAccount,
} from "../src/core/credential-accounts.ts";
import { CredentialFailoverError, runCredentialFailover } from "../src/core/credential-pool/failover.ts";
import { listRotationSlots } from "../src/core/credential-pool/rotation-slots.ts";
import { CredentialSlotRepository } from "../src/core/credential-pool/state-store.ts";
import { getProviderAccounts } from "../src/core/extensions/builtin/anthropic-subscription/account-management.ts";
import { emptyCredential } from "../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	AllAccountsBlockedError,
	selectAccount as selectClaudeAccount,
} from "../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import { emptyCredential as emptyCursorCredential } from "../src/core/extensions/builtin/cursor-cli-oauth/accounts.ts";
import {
	AllCursorAccountsBlockedError,
	selectAccount as selectCursorAccount,
} from "../src/core/extensions/builtin/cursor-cli-oauth/affinity.ts";

const NOW_FAR_FUTURE = 4_102_444_800_000;
const ELAPSED = 1;

type StoredBlock = {
	readonly blockReason?: "auth_error" | "rate_limit" | "account_disabled";
	readonly blockedUntil?: number;
};
type ListedBlock = Pick<CredentialAccountSummary, "blocked" | "blockedReason" | "blockedUntil">;

const storedSlot = (block: StoredBlock) => ({
	name: "default",
	access: "fake-a",
	refresh: "fake-r",
	expires: NOW_FAR_FUTURE,
	source: "login" as const,
	...block,
});

/** A stored Claude account is a claude CLI account and holds no token (senpi#4436). */
const storedClaudeSlot = (block: StoredBlock) => ({
	name: "default",
	source: "login" as const,
	store: "claude-cli" as const,
	dirId: "c".repeat(32),
	...block,
});

/** Whether the provider lane's own selector hands this stored account to a request right now. */
async function laneSelectorAccepts(provider: string, block: StoredBlock): Promise<boolean> {
	try {
		if (provider === "openai") {
			const stream = runCredentialFailover({
				listSlots: () =>
					listRotationSlots(
						{ providerId: provider, credential: storage.get(provider), env: () => undefined, repository },
						{ acquireLeases: false },
					),
				select: (slots) => {
					const slot = slots[0];
					if (!slot) throw new Error("No candidate slot");
					return slot;
				},
				runAttempt: async function* () {
					yield "accepted";
				},
				isCommittedOutput: () => true,
				persistBlock: () => {
					throw new Error("A successful synthetic attempt must not persist a block");
				},
			});
			for await (const _event of stream) {
				// Consuming the real failover engine proves this slot reached an attempt.
			}
		} else if (provider === "anthropic-subscription") selectClaudeAccount([storedClaudeSlot(block)]);
		else selectCursorAccount([storedSlot(block)]);
		return true;
	} catch (error) {
		if (error instanceof CredentialFailoverError && error.action.kind === "fail_request") return false;
		if (error instanceof AllAccountsBlockedError || error instanceof AllCursorAccountsBlockedError) return false;
		throw error;
	}
}

// Every block state a provider lane stores on its own slot, with the listing it must produce. The Cursor lane keeps an
// auth block until re-login; the Claude lane re-probes one whose deadline passed or that predates deadlines (senpi#3264).
// Generic rotation reads only sidecar health, including re-probing deadline-less auth blocks (senpi#4885).
const STORED_BLOCK_CASES: readonly {
	provider: string;
	label: string;
	stored: StoredBlock;
	health?: StoredBlock;
	listed: ListedBlock;
}[] = [
	{ provider: "cursor-cli-oauth", label: "healthy", stored: {}, listed: { blocked: false } },
	{
		provider: "cursor-cli-oauth",
		label: "auth block with no deadline",
		stored: { blockReason: "auth_error" },
		listed: { blocked: true, blockedReason: "auth_error" },
	},
	{
		provider: "cursor-cli-oauth",
		label: "auth block whose deadline passed",
		stored: { blockReason: "auth_error", blockedUntil: ELAPSED },
		listed: { blocked: true, blockedReason: "auth_error" },
	},
	{
		provider: "cursor-cli-oauth",
		label: "live rate limit",
		stored: { blockReason: "rate_limit", blockedUntil: NOW_FAR_FUTURE },
		listed: { blocked: true, blockedReason: "rate_limit", blockedUntil: NOW_FAR_FUTURE },
	},
	{
		provider: "cursor-cli-oauth",
		label: "elapsed rate limit",
		stored: { blockReason: "rate_limit", blockedUntil: ELAPSED },
		listed: { blocked: false },
	},
	{ provider: "anthropic-subscription", label: "healthy", stored: {}, listed: { blocked: false } },
	{
		provider: "anthropic-subscription",
		label: "auth block with no deadline",
		stored: { blockReason: "auth_error" },
		listed: { blocked: false },
	},
	{
		provider: "anthropic-subscription",
		label: "auth block whose deadline passed",
		stored: { blockReason: "auth_error", blockedUntil: ELAPSED },
		listed: { blocked: false },
	},
	{
		provider: "anthropic-subscription",
		label: "live auth block",
		stored: { blockReason: "auth_error", blockedUntil: NOW_FAR_FUTURE },
		listed: { blocked: true, blockedReason: "auth_error", blockedUntil: NOW_FAR_FUTURE },
	},
	{ provider: "openai", label: "healthy", stored: {}, listed: { blocked: false } },
	{
		provider: "openai",
		label: "stored auth block with no deadline",
		stored: { blockReason: "auth_error" },
		listed: { blocked: false },
	},
	{
		provider: "openai",
		label: "stored live auth block",
		stored: { blockReason: "auth_error", blockedUntil: NOW_FAR_FUTURE },
		listed: { blocked: false },
	},
	{
		provider: "openai",
		label: "stored disabled block",
		stored: { blockReason: "account_disabled" },
		listed: { blocked: false },
	},
	{
		provider: "openai",
		label: "health auth block with no deadline is re-probed",
		stored: {},
		health: { blockReason: "auth_error" },
		listed: { blocked: false },
	},
	{
		provider: "openai",
		label: "health disabled block with no deadline",
		stored: {},
		health: { blockReason: "account_disabled" },
		listed: { blocked: true, blockedReason: "disabled" },
	},
	{
		provider: "openai",
		label: "health live auth block",
		stored: {},
		health: { blockReason: "auth_error", blockedUntil: NOW_FAR_FUTURE },
		listed: { blocked: true, blockedReason: "auth_error", blockedUntil: NOW_FAR_FUTURE },
	},
	{
		provider: "openai",
		label: "health expired auth block",
		stored: {},
		health: { blockReason: "auth_error", blockedUntil: ELAPSED },
		listed: { blocked: false },
	},
];

let dir: string;
let storage: AuthStorage;
let repository: CredentialSlotRepository;
let statePath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "credential-accounts-"));
	storage = AuthStorage.create(join(dir, "auth.json"));
	statePath = join(dir, "credential-pool-state.json");
	repository = new CredentialSlotRepository(statePath);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

async function seedPool(provider: string): Promise<void> {
	await storage.modify(provider, async () => ({
		type: "api_key",
		key: "key-default",
		accounts: [
			{ name: "default", key: "key-default", source: "login" },
			{ name: "work", key: "key-work", source: "login" },
		],
	}));
}

describe("provider-neutral credential accounts", () => {
	test("lists accounts for ANY provider, not just the Claude lane", async () => {
		await seedPool("openai");

		const accounts = await getCredentialAccounts(storage, "openai", {}, repository);

		expect(accounts.map((account) => account.name)).toEqual(["default", "work"]);
		expect(accounts.every((account) => account.source === "login")).toBe(true);
	});

	test("account summaries carry no credential material", async () => {
		await seedPool("openai");

		const accounts = await getCredentialAccounts(storage, "openai", {}, repository);

		const serialized = JSON.stringify(accounts);
		expect(serialized).not.toContain("key-default");
		expect(serialized).not.toContain("key-work");
		expect(Object.keys(accounts[0] ?? {}).sort()).toEqual(["blocked", "name", "pinned", "source"]);
	});

	test("sidecar health surfaces as blocked without auth.json carrying block state", async () => {
		await seedPool("openai");
		const workRevision = await repository.storedCredentialRevision("openai", "work", { key: "key-work" });
		await repository.mutateSlotState("openai", "stored", "work", () => ({
			blockedUntil: NOW_FAR_FUTURE,
			blockReason: "rate_limit",
			credentialRevision: workRevision,
		}));

		const accounts = await getCredentialAccounts(storage, "openai", {}, repository);

		expect(accounts.find((account) => account.name === "work")?.blocked).toBe(true);
		expect(accounts.find((account) => account.name === "default")?.blocked).toBe(false);
		expect(readFileSync(join(dir, "auth.json"), "utf-8")).not.toContain("blockedUntil");
	});

	test("a known-bad key reports auth_error with its re-probe time, apart from a cooldown (senpi#4327)", async () => {
		await seedPool("openai");
		for (const [name, key, blockReason] of [
			["default", "key-default", "auth_error"],
			["work", "key-work", "rate_limit"],
		] as const) {
			const credentialRevision = await repository.storedCredentialRevision("openai", name, { key });
			await repository.mutateSlotState("openai", "stored", name, () => ({
				blockedUntil: NOW_FAR_FUTURE,
				blockReason,
				credentialRevision,
			}));
		}

		const accounts = await getCredentialAccounts(storage, "openai", {}, repository);

		expect(accounts).toEqual([
			{
				name: "default",
				source: "login",
				blocked: true,
				blockedReason: "auth_error",
				blockedUntil: NOW_FAR_FUTURE,
				pinned: false,
			},
			{
				name: "work",
				source: "login",
				blocked: true,
				blockedReason: "rate_limit",
				blockedUntil: NOW_FAR_FUTURE,
				pinned: false,
			},
		]);
	});

	test("a generic slot reports only health state even when auth.json has a later block (senpi#4885)", async () => {
		const slotUntil = NOW_FAR_FUTURE + 60_000;
		await storage.modify("openai", async () => ({
			type: "api_key",
			key: "key-default",
			accounts: [
				{
					name: "default",
					key: "key-default",
					source: "login",
					blockedUntil: slotUntil,
					blockReason: "rate_limit",
				},
			],
		}));
		const credentialRevision = await repository.storedCredentialRevision("openai", "default", { key: "key-default" });
		await repository.mutateSlotState("openai", "stored", "default", () => ({
			blockedUntil: NOW_FAR_FUTURE,
			blockReason: "auth_error",
			credentialRevision,
		}));

		const [account] = await getCredentialAccounts(storage, "openai", {}, repository);

		// Generic rotation never sees the auth.json deadline.
		expect(account).toMatchObject({ blocked: true, blockedReason: "auth_error", blockedUntil: NOW_FAR_FUTURE });
	});

	test("a disabled account reports disabled with no re-probe time", async () => {
		await storage.modify("openai", async () => ({
			type: "api_key",
			key: "key-default",
			accounts: [{ name: "default", key: "key-default", source: "login", blockReason: "account_disabled" }],
		}));
		const credentialRevision = await repository.storedCredentialRevision("openai", "default", { key: "key-default" });
		await repository.mutateSlotState("openai", "stored", "default", () => ({
			blockReason: "account_disabled",
			credentialRevision,
		}));

		const [account] = await getCredentialAccounts(storage, "openai", {}, repository);

		expect(account).toMatchObject({ blocked: true, blockedReason: "disabled" });
		expect(account).not.toHaveProperty("blockedUntil");
	});

	// The generic listing adds the CLI account fields (store, signIn) on top of the lane's own.
	const sameAccounts = (lane: readonly object[]) => lane.map((account) => expect.objectContaining(account));

	test("the Claude lane listing agrees with the generic one for a disabled account", async () => {
		await storage.modify("anthropic-subscription", async () => ({
			...emptyCredential(),
			accounts: [
				{
					name: "default",
					source: "login",
					store: "claude-cli",
					dirId: "a".repeat(32),
					blockReason: "account_disabled",
				},
			],
		}));

		const generic = await getCredentialAccounts(storage, "anthropic-subscription", {}, repository);

		expect(generic[0]).toMatchObject({ blocked: true, blockedReason: "disabled" });
		expect(generic).toEqual(sameAccounts(getProviderAccounts(storage, "anthropic-subscription", {})));
	});

	test("a stored Claude account that still holds tokens is absent from both listings (senpi#4436)", async () => {
		await storage.modify("anthropic-subscription", async () => ({
			...emptyCredential(),
			accounts: [
				{ name: "legacy", access: "fake-a", refresh: "fake-r", expires: NOW_FAR_FUTURE, source: "login" },
				{ name: "cli", source: "login", store: "claude-cli", dirId: "b".repeat(32) },
			],
		}));

		const generic = await getCredentialAccounts(storage, "anthropic-subscription", {}, repository);
		const lane = getProviderAccounts(storage, "anthropic-subscription", {});

		expect(generic.map((account) => account.name)).toEqual(["cli"]);
		expect(lane.map((account) => account.name)).toEqual(["cli"]);
		expect(generic).toEqual(sameAccounts(lane));
	});

	test("an env key blocked for auth reports auth_error; an expired block reports no reason", async () => {
		const env = { OPENAI_API_KEY: "sk-one", OPENAI_API_KEY_2: "sk-two" };
		const bad = await repository.envCredentialRevision("OPENAI_API_KEY", "sk-one");
		await repository.mutateSlotState("openai", "env", "env", () => ({
			blockedUntil: NOW_FAR_FUTURE,
			blockReason: "auth_error",
			credentialRevision: bad,
		}));
		const lapsed = await repository.envCredentialRevision("OPENAI_API_KEY_2", "sk-two");
		await repository.mutateSlotState("openai", "env", "env-2", () => ({
			blockedUntil: 1,
			blockReason: "auth_error",
			credentialRevision: lapsed,
		}));

		const accounts = await getCredentialAccounts(storage, "openai", env, repository);

		expect(accounts[0]).toMatchObject({ blocked: true, blockedReason: "auth_error", blockedUntil: NOW_FAR_FUTURE });
		expect(Object.keys(accounts[1] ?? {}).sort()).toEqual(["blocked", "name", "pinned", "source"]);
	});

	// The listing must never call an account available that selection skips, or a client routes to it (senpi#4365 follow-up).
	test.each(STORED_BLOCK_CASES)(
		"$provider $label: the listing agrees with the lane's selector",
		async ({ provider, stored, health, listed }) => {
			const base = provider === "anthropic-subscription" ? emptyCredential() : emptyCursorCredential();
			await storage.modify(provider, async () =>
				provider === "openai"
					? { type: "api_key", key: "key-default", accounts: [{ name: "default", key: "key-default", ...stored }] }
					: provider === "anthropic-subscription"
						? { ...base, accounts: [storedClaudeSlot(stored)] }
						: { ...base, accounts: [storedSlot(stored)] },
			);
			if (health !== undefined) {
				const credentialRevision = await repository.storedCredentialRevision(provider, "default", {
					key: "key-default",
				});
				await repository.mutateSlotState(provider, "stored", "default", () => ({ ...health, credentialRevision }));
			}

			const [account] = await getCredentialAccounts(storage, provider, {}, repository);

			const {
				name: _name,
				source: _source,
				pinned: _pinned,
				// The generic listing adds the CLI account fields on top of the block state.
				store: _store,
				signIn: _signIn,
				...block
			} = account ?? { name: "", source: "", pinned: false };
			expect(account?.blocked).toBe(!(await laneSelectorAccepts(provider, stored)));
			expect(block).toEqual(listed);
			if (provider === "anthropic-subscription")
				expect([account]).toEqual(sameAccounts(getProviderAccounts(storage, provider, {})));
		},
	);

	test("a re-login clears a pool block in the listing exactly as selection drops it", async () => {
		await seedPool("openai");
		const oldRevision = await repository.storedCredentialRevision("openai", "work", { key: "key-work-old" });
		await repository.mutateSlotState("openai", "stored", "work", () => ({
			blockedUntil: NOW_FAR_FUTURE,
			blockReason: "auth_error",
			credentialRevision: oldRevision,
		}));

		const accounts = await getCredentialAccounts(storage, "openai", {}, repository);
		const slots = await listRotationSlots(
			{ providerId: "openai", credential: storage.get("openai"), env: () => undefined, repository },
			{ acquireLeases: false },
		);

		expect(accounts.find((account) => account.name === "work")).toMatchObject({ blocked: false });
		expect(slots.find((slot) => slot.name === "work")).not.toHaveProperty("blockReason");
	});

	test("pinning marks exactly one account and unpinning clears it", async () => {
		await seedPool("openai");

		await pinCredentialAccount(storage, "openai", "work", {}, repository);
		let accounts = await getCredentialAccounts(storage, "openai", {}, repository);
		expect(accounts.filter((account) => account.pinned).map((account) => account.name)).toEqual(["work"]);

		await pinCredentialAccount(storage, "openai", null, {}, repository);
		accounts = await getCredentialAccounts(storage, "openai", {}, repository);
		expect(accounts.some((account) => account.pinned)).toBe(false);
	});

	test("pinning an unknown account is refused", async () => {
		await seedPool("openai");
		await expect(pinCredentialAccount(storage, "openai", "nope", {}, repository)).rejects.toThrow(
			"Provider account not found: nope",
		);
	});

	test("removing a stored account keeps its sibling and drops its sidecar health", async () => {
		await seedPool("openai");
		await repository.mutateSlotState("openai", "stored", "work", () => ({ failureCount: 3 }));

		await removeCredentialAccount(storage, "openai", "work", {}, repository);

		const accounts = await getCredentialAccounts(storage, "openai", {}, repository);
		expect(accounts.map((account) => account.name)).toEqual(["default"]);
		expect(await repository.listSlots("openai", "stored")).toEqual({});
	});

	test("removing the final stored account deletes the provider credential", async () => {
		await storage.modify("openai", async () => ({
			type: "api_key",
			key: "only-key",
			accounts: [{ name: "only", key: "only-key", source: "login" }],
		}));

		await removeCredentialAccount(storage, "openai", "only", {}, repository);

		expect(await storage.read("openai")).toBeUndefined();
		expect(await getCredentialAccounts(storage, "openai", {}, repository)).toEqual([]);
	});

	test("env-backed accounts are listed when nothing is stored and refuse removal", async () => {
		const env = { OPENAI_API_KEY: "sk-one", OPENAI_API_KEY_2: "sk-two" };

		const accounts = await getCredentialAccounts(storage, "openai", env, repository);

		expect(accounts.map((account) => account.name)).toEqual(["env", "env-2"]);
		expect(accounts.every((account) => account.source === "env")).toBe(true);
		expect(JSON.stringify(accounts)).not.toContain("sk-one");
		await expect(removeCredentialAccount(storage, "openai", "env", env, repository)).rejects.toThrow(
			"Environment provider account cannot be removed: env",
		);
	});

	test("a stored credential hides env slots, matching resolution precedence", async () => {
		await seedPool("openai");

		const accounts = await getCredentialAccounts(
			storage,
			"openai",
			{ OPENAI_API_KEY: "sk-one", OPENAI_API_KEY_2: "sk-two" },
			repository,
		);

		expect(accounts.map((account) => account.name)).toEqual(["default", "work"]);
	});
});
