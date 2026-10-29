import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	getCredentialAccounts,
	pinCredentialAccount,
	removeCredentialAccount,
} from "../src/core/credential-accounts.ts";
import { CredentialSlotRepository } from "../src/core/credential-pool/state-store.ts";
import { getProviderAccounts } from "../src/core/extensions/builtin/anthropic-subscription/account-management.ts";
import { emptyCredential } from "../src/core/extensions/builtin/anthropic-subscription/accounts.ts";

const NOW_FAR_FUTURE = 4_102_444_800_000;

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

	test("a slot blocked in both sources reports the later expiry (senpi#4365 review)", async () => {
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

		// The rejected key stays the reason: the account is usable only once both blocks lift.
		expect(account).toMatchObject({ blocked: true, blockedReason: "auth_error", blockedUntil: slotUntil });
	});

	test("a disabled account reports disabled with no re-probe time", async () => {
		await storage.modify("openai", async () => ({
			type: "api_key",
			key: "key-default",
			accounts: [{ name: "default", key: "key-default", source: "login", blockReason: "account_disabled" }],
		}));

		const [account] = await getCredentialAccounts(storage, "openai", {}, repository);

		expect(account).toMatchObject({ blocked: true, blockedReason: "disabled" });
		expect(account).not.toHaveProperty("blockedUntil");
	});

	test("the Claude lane listing agrees with the generic one for a disabled account", async () => {
		await storage.modify("anthropic-subscription", async () => ({
			...emptyCredential(),
			accounts: [
				{
					name: "default",
					access: "fake-a",
					refresh: "fake-r",
					expires: NOW_FAR_FUTURE,
					source: "login",
					blockReason: "account_disabled",
				},
			],
		}));

		const generic = await getCredentialAccounts(storage, "anthropic-subscription", {}, repository);

		expect(generic[0]).toMatchObject({ blocked: true, blockedReason: "disabled" });
		expect(getProviderAccounts(storage, "anthropic-subscription", {})).toEqual(generic);
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
