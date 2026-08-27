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
		await repository.mutateSlotState("openai", "stored", "work", () => ({
			blockedUntil: NOW_FAR_FUTURE,
			blockReason: "rate_limit",
		}));

		const accounts = await getCredentialAccounts(storage, "openai", {}, repository);

		expect(accounts.find((account) => account.name === "work")?.blocked).toBe(true);
		expect(accounts.find((account) => account.name === "default")?.blocked).toBe(false);
		expect(readFileSync(join(dir, "auth.json"), "utf-8")).not.toContain("blockedUntil");
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
