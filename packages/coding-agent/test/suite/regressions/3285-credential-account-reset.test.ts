import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { resetCredentialAccount } from "../../../src/core/credential-account-reset.ts";
import { getCredentialAccounts } from "../../../src/core/credential-accounts.ts";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";
import { emptyCredential } from "../../../src/core/extensions/builtin/cursor-cli-oauth/accounts.ts";

const FAR_FUTURE = 4_102_444_800_000;

let dir: string;
let repository: CredentialSlotRepository;
let storage: AuthStorage;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pool-reset-3285-"));
	repository = new CredentialSlotRepository(join(dir, "credential-pool-state.json"));
	storage = AuthStorage.create(join(dir, "auth.json"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function pooled(): PooledCredential {
	return {
		type: "api_key",
		key: "key-a",
		accounts: [
			{ name: "a", key: "key-a", source: "login" },
			{ name: "b", key: "key-b", source: "login" },
		],
	};
}

async function blocked(name: string, provider = "test"): Promise<boolean | undefined> {
	const accounts = await getCredentialAccounts(storage, provider, {}, repository);
	return accounts.find((account) => account.name === name)?.blocked;
}

async function seedBlock(slot: string, key: string): Promise<void> {
	const credentialRevision = await repository.storedCredentialRevision("test", slot, { key });
	await repository.mutateSlotState("test", "stored", slot, () => ({
		blockedUntil: FAR_FUTURE,
		blockReason: "rate_limit",
		failureCount: 1,
		credentialRevision,
	}));
}

describe("an account's cooldown can be cleared on request (senpi#3285)", () => {
	test("reset clears the sidecar exclusion so the account is listed available again", async () => {
		await storage.modify("test", async () => pooled());
		await seedBlock("b", "key-b");
		expect(await blocked("b")).toBe(true);

		await resetCredentialAccount(storage, "test", "b", {}, repository);

		expect(await blocked("b")).toBe(false);
	});

	test("reset clears a block a provider lane stored on the account itself", async () => {
		// Cursor actually selects from auth.json block fields; the generic pool does not (senpi#4885).
		const provider = "cursor-cli-oauth";
		await storage.modify(provider, async () => ({
			...emptyCredential(),
			accounts: [
				{ name: "a", access: "fake-a", refresh: "fake-r", expires: FAR_FUTURE, source: "login" },
				{
					name: "b",
					access: "fake-b",
					refresh: "fake-s",
					expires: FAR_FUTURE,
					source: "login",
					blockReason: "auth_error",
					blockedUntil: FAR_FUTURE,
				},
			],
		}));
		expect(await blocked("b", provider)).toBe(true);

		await resetCredentialAccount(storage, provider, "b", {}, repository);

		expect(await blocked("b", provider)).toBe(false);
		expect(readFileSync(join(dir, "auth.json"), "utf-8")).not.toContain("auth_error");
	});

	test("reset refuses an unknown account", async () => {
		await storage.modify("test", async () => pooled());

		await expect(resetCredentialAccount(storage, "test", "missing", {}, repository)).rejects.toThrow(
			"Provider account not found: missing",
		);
	});
});
