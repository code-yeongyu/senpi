import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	getCredentialAccounts,
	pinCredentialAccount,
	removeCredentialAccount,
	resolveCredentialAccountSelector,
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
	vi.restoreAllMocks();
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

	test("distinguishes token lifetime from refreshability for ChatGPT subscriptions", async () => {
		const now = Date.UTC(2026, 8, 29);
		vi.spyOn(Date, "now").mockReturnValue(now);
		await storage.modify("chatgpt-subscription", async () => ({
			type: "oauth",
			access: "fake-future-access",
			refresh: "fake-future-refresh",
			expires: now + 900_000,
			accounts: [
				{ name: "future", access: "fake-future-access", refresh: "fake-future-refresh", expires: now + 900_000 },
				{ name: "expired", access: "fake-expired-access", refresh: "fake-expired-refresh", expires: now - 1_000 },
				{ name: "no-refresh", access: "fake-no-refresh-access", expires: now - 1_000 },
				{ name: "unknown", access: "fake-unknown-access", refresh: "fake-unknown-refresh" },
				{
					name: "invalid-expiry",
					access: "fake-invalid-access",
					refresh: "fake-invalid-refresh",
					expires: Number.MAX_SAFE_INTEGER,
				},
			],
		}));

		const accounts = await getCredentialAccounts(storage, "chatgpt-subscription", {}, repository);

		expect(
			accounts.map(({ name, expiresAt, expiresInMs, authAction }) => ({
				name,
				expiresAt,
				expiresInMs,
				authAction,
			})),
		).toEqual([
			{ name: "future", expiresAt: now + 900_000, expiresInMs: 900_000, authAction: "valid" },
			{ name: "expired", expiresAt: now - 1_000, expiresInMs: 0, authAction: "refresh-on-use" },
			{ name: "no-refresh", expiresAt: now - 1_000, expiresInMs: 0, authAction: "reauth-required" },
			{ name: "unknown", expiresAt: undefined, expiresInMs: undefined, authAction: "unknown" },
			{ name: "invalid-expiry", expiresAt: undefined, expiresInMs: undefined, authAction: "unknown" },
		]);
		expect(JSON.stringify(accounts)).not.toContain("fake-future-refresh");
	});

	test("reports re-auth only for applicable authentication failures", async () => {
		const now = Date.UTC(2026, 8, 29);
		vi.spyOn(Date, "now").mockReturnValue(now);
		await storage.modify("chatgpt-subscription", async () => ({
			type: "oauth",
			access: "fake-auth-access",
			refresh: "fake-auth-refresh",
			expires: now + 900_000,
			accounts: [
				{ name: "auth", access: "fake-auth-access", refresh: "fake-auth-refresh", expires: now + 900_000 },
				{
					name: "cooldown",
					access: "fake-cooldown-access",
					refresh: "fake-cooldown-refresh",
					expires: now + 900_000,
				},
				{
					name: "disabled",
					access: "fake-disabled-access",
					refresh: "fake-disabled-refresh",
					expires: now + 900_000,
				},
				{ name: "stale", access: "fake-stale-access", refresh: "fake-stale-refresh", expires: now + 900_000 },
			],
		}));
		for (const [name, reason] of [
			["auth", "auth_error"],
			["cooldown", "rate_limit"],
			["disabled", "account_disabled"],
			["stale", "auth_error"],
		] as const) {
			const revision = await repository.storedCredentialRevision("chatgpt-subscription", name, {
				access: `fake-${name}-access`,
				refresh: `fake-${name}-refresh`,
			});
			await repository.mutateSlotState("chatgpt-subscription", "stored", name, () => ({
				blockReason: reason,
				blockedUntil: NOW_FAR_FUTURE,
				credentialRevision: name === "stale" ? "0".repeat(64) : revision,
			}));
		}

		const accounts = await getCredentialAccounts(storage, "chatgpt-subscription", {}, repository);

		expect(accounts.map(({ name, authAction }) => ({ name, authAction }))).toEqual([
			{ name: "auth", authAction: "reauth-required" },
			{ name: "cooldown", authAction: "temporarily-unavailable" },
			{ name: "disabled", authAction: "account-disabled" },
			{ name: "stale", authAction: "valid" },
		]);
		expect(JSON.stringify(accounts)).not.toContain("fake-auth-refresh");
	});

	test("resolves immutable IDs, verified emails and unique profile shorthand", () => {
		const accounts = [
			{ name: "default", source: "login", blocked: false, pinned: false, displayName: "personal" },
			{
				name: "login-2",
				source: "login",
				blocked: false,
				pinned: true,
				displayName: "Research Desk",
				verifiedEmail: "research@astrabit.io",
			},
			{ name: "login-3", source: "login", blocked: false, pinned: false, verifiedEmail: "other@example.io" },
		] as const;

		expect(resolveCredentialAccountSelector(accounts, "login-2")).toBe("login-2");
		expect(resolveCredentialAccountSelector(accounts, "RESEARCH@ASTRABIT.IO")).toBe("login-2");
		expect(resolveCredentialAccountSelector(accounts, "research")).toBe("login-2");
		expect(resolveCredentialAccountSelector(accounts, "research desk")).toBe("login-2");
		expect(resolveCredentialAccountSelector(accounts, "personal")).toBe("default");
	});

	test("refuses duplicate profile names and email local parts instead of choosing a slot", () => {
		const accounts = [
			{ name: "default", source: "login", blocked: false, pinned: true, displayName: "personal" },
			{ name: "login-2", source: "login", blocked: false, pinned: false, verifiedEmail: "research@astrabit.io" },
			{ name: "login-3", source: "login", blocked: false, pinned: false, verifiedEmail: "research@other.io" },
			{ name: "login-4", source: "login", blocked: false, pinned: false, displayName: "research" },
		] as const;

		expect(() => resolveCredentialAccountSelector(accounts, "research")).toThrow();
		expect(() => resolveCredentialAccountSelector(accounts, "missing")).toThrow();
		expect(resolveCredentialAccountSelector(accounts, "login-2")).toBe("login-2");
		expect(resolveCredentialAccountSelector(accounts, "research@other.io")).toBe("login-3");
		const sameEmail = [accounts[1], { ...accounts[2], verifiedEmail: "research@astrabit.io" }];
		expect(() => resolveCredentialAccountSelector(sameEmail, "research@astrabit.io")).toThrow();
		expect(resolveCredentialAccountSelector(sameEmail, "login-2")).toBe("login-2");
	});

	test("does not echo a token-shaped selector in unknown or ambiguous errors", () => {
		const fakeToken = "eyJhbGciOiJSUzI1NiJ9.fake-token-signature";
		const unknown = [{ name: "default", source: "login", blocked: false, pinned: false }] as const;
		const ambiguous = [
			{ name: "default", source: "login", blocked: false, pinned: false, displayName: fakeToken },
			{ name: "work", source: "login", blocked: false, pinned: false, displayName: fakeToken },
		] as const;
		for (const accounts of [unknown, ambiguous]) {
			let failure: unknown;
			try {
				resolveCredentialAccountSelector(accounts, fakeToken);
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(Error);
			expect(String(failure)).not.toContain(fakeToken);
		}
	});

	test.each([
		[
			"pooled malformed and control-character metadata",
			{
				type: "oauth",
				access: "pooled-secret-access",
				refresh: "pooled-secret-refresh",
				expires: NOW_FAR_FUTURE,
				accounts: [
					{
						name: "malformed",
						access: "malformed-secret-access",
						refresh: "malformed-secret-refresh",
						expires: NOW_FAR_FUTURE,
						verifiedIdentity: {
							userId: "user-malformed",
							workspaceId: { unexpected: "workspace-secret" },
							verifiedEmail: "malformed@example.test",
						},
					},
					{
						name: "control",
						access: "control-secret-access",
						refresh: "control-secret-refresh",
						expires: NOW_FAR_FUTURE,
						verifiedIdentity: {
							userId: "user-control",
							workspaceId: "workspace-secret\u001b[31m",
							verifiedEmail: "control@example.test\u0007",
						},
					},
				],
			},
			["malformed", "control"],
		],
		[
			"flat invalid metadata",
			{
				type: "oauth",
				access: "flat-secret-access",
				refresh: "flat-secret-refresh",
				expires: NOW_FAR_FUTURE,
				verifiedIdentity: {
					userId: "user-flat",
					workspaceId: "workspace-secret",
					verifiedEmail: "not-an-email",
				},
			},
			["default"],
		],
	] as const)("falls back safely for %s", async (_case, persisted, expectedNames) => {
		await storage.modify("chatgpt-subscription", async () => persisted as never);

		const accounts = await getCredentialAccounts(storage, "chatgpt-subscription", {}, repository);
		const serialized = JSON.stringify(accounts);

		expect(accounts.map((account) => account.name)).toEqual(expectedNames);
		expect(accounts.every((account) => account.identitySource === "slot-id")).toBe(true);
		expect(accounts.every((account) => account.verifiedEmail === undefined)).toBe(true);
		expect(accounts.every((account) => account.workspaceHint === undefined)).toBe(true);
		expect(serialized).not.toContain("secret");
		expect(serialized).not.toContain("\u001b");
		expect(serialized).not.toContain("\u0007");
	});

	test.each([
		["flat", false],
		["pooled", true],
	])("shows a bounded routing hint for %s accounts without verified identity", async (_case, pooled) => {
		const workspaceId = "workspace-without-id-token";
		const access = `fake.${Buffer.from(
			JSON.stringify({
				"https://api.openai.com/auth": { chatgpt_account_id: workspaceId },
			}),
		).toString("base64url")}.fake`;
		const credential = { type: "oauth" as const, access, refresh: "fake-refresh", expires: NOW_FAR_FUTURE };
		await storage.modify("chatgpt-subscription", async () =>
			pooled ? { ...credential, accounts: [{ name: "default", ...credential }] } : credential,
		);

		const accounts = await getCredentialAccounts(storage, "chatgpt-subscription", {}, repository);

		expect(accounts[0]).toMatchObject({
			name: "default",
			workspaceHint: "id-token",
			identitySource: "slot-id",
		});
		expect(accounts[0].verifiedEmail).toBeUndefined();
		expect(JSON.stringify(accounts)).not.toContain(workspaceId);
		expect(JSON.stringify(accounts)).not.toContain("fake-refresh");
	});

	test("omits unsafe routing hints from unverified access tokens", async () => {
		const ids = ["short", "workspace-id\u001b[31m", "workspace.with.dot"];
		const accounts = ids.map((workspaceId, index) => ({
			name: `login-${index + 2}`,
			access: `fake.${Buffer.from(
				JSON.stringify({
					"https://api.openai.com/auth": { chatgpt_account_id: workspaceId },
				}),
			).toString("base64url")}.fake`,
			refresh: "fake-refresh",
			expires: NOW_FAR_FUTURE,
		}));
		await storage.modify("chatgpt-subscription", async () => ({
			type: "oauth",
			...accounts[0],
			accounts,
		}));

		const summaries = await getCredentialAccounts(storage, "chatgpt-subscription", {}, repository);

		expect(summaries.map((account) => account.workspaceHint)).toEqual([undefined, undefined, undefined]);
		expect(summaries.every((account) => account.identitySource === "slot-id")).toBe(true);
		expect(JSON.stringify(summaries)).not.toContain("\u001b");
		expect(JSON.stringify(summaries)).not.toContain("fake-refresh");
	});

	test("marks verified email separately from editable names and fallback IDs", async () => {
		await storage.modify("chatgpt-subscription", async () => ({
			type: "oauth",
			access: "fake-secret-access",
			refresh: "fake-secret-refresh",
			expires: NOW_FAR_FUTURE,
			accounts: [
				{
					name: "login-2",
					displayName: "Research Desk",
					access: "fake-secret-access",
					refresh: "fake-secret-refresh",
					expires: NOW_FAR_FUTURE,
					verifiedIdentity: {
						userId: "user-research",
						workspaceId: "acct-workspace-001",
						verifiedEmail: "research@astrabit.io",
					},
				},
				{ name: "personal", displayName: "Home", access: "fake-personal-access", refresh: "fake-personal-refresh" },
				{ name: "legacy", access: "fake-legacy-access", refresh: "fake-legacy-refresh" },
			],
		}));

		const accounts = await getCredentialAccounts(storage, "chatgpt-subscription", {}, repository);

		expect(
			accounts.map(({ name, displayName, verifiedEmail, workspaceHint, identitySource }) => ({
				name,
				displayName,
				verifiedEmail,
				workspaceHint,
				identitySource,
			})),
		).toEqual([
			{
				name: "login-2",
				displayName: "Research Desk",
				verifiedEmail: "research@astrabit.io",
				workspaceHint: "pace-001",
				identitySource: "verified-email",
			},
			{
				name: "personal",
				displayName: "Home",
				verifiedEmail: undefined,
				workspaceHint: undefined,
				identitySource: "manual-name",
			},
			{
				name: "legacy",
				displayName: undefined,
				verifiedEmail: undefined,
				workspaceHint: undefined,
				identitySource: "slot-id",
			},
		]);
		expect(JSON.stringify(accounts)).not.toContain("fake-secret");
		expect(JSON.stringify(accounts)).not.toContain("acct-workspace-001");
	});
});
