import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLoginSlot, type PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { describeAccountHealth, getCredentialAccounts } from "../../../src/core/credential-accounts.ts";
import {
	CREDENTIAL_POOL_STATE_FILENAME,
	CredentialSlotRepository,
} from "../../../src/core/credential-pool/state-store.ts";
import gptAccountExtension from "../../../src/core/extensions/builtin/gpt-account.ts";
import { createLoginCommandContext, registerCommand } from "../account-command-harness.ts";

// senpi#3216: an account-wide block shows its reason and either the time it lifts or the command
// that fixes it, and `/gpt-account login <id>` logs an existing account in again in place.

const PROVIDER = "chatgpt-subscription";
const UNTIL = Date.parse("2026-10-13T20:00:00.000Z");

let dir: string;
let storage: AuthStorage;
let repository: CredentialSlotRepository;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "issue-3216-accounts-"));
	storage = AuthStorage.create(join(dir, "auth.json"));
	repository = new CredentialSlotRepository(join(dir, CREDENTIAL_POOL_STATE_FILENAME));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function oauth(access: string): { access: string; refresh: string; expires: number } {
	return { access, refresh: `${access}-refresh`, expires: Date.parse("2030-01-01T00:00:00.000Z") };
}

async function seedAccounts(): Promise<void> {
	await storage.modify(PROVIDER, async () => ({
		type: "oauth",
		...oauth("old-a"),
		accounts: [
			{ name: "default", displayName: "Personal", source: "login", ...oauth("old-a") },
			{ name: "work", source: "login", ...oauth("old-b") },
			{ name: "spare", source: "login", ...oauth("old-c") },
		],
		pinned: "work",
	}));
}

async function block(
	name: string,
	access: string,
	patch: { blockReason: "rate_limit" | "auth_error" | "account_disabled"; blockedUntil?: number },
) {
	const credentialRevision = await repository.storedCredentialRevision(PROVIDER, name, {
		access,
		refresh: `${access}-refresh`,
	});
	await repository.mutateSlotState(PROVIDER, "stored", name, () => ({ ...patch, credentialRevision }));
}

describe("senpi#3216 account block reasons", () => {
	it("each reason renders distinctly: a usage limit with its reset time, auth and billing with their fix", async () => {
		// given - three accounts, each blocked for a different reason.
		await seedAccounts();
		await block("default", "old-a", { blockReason: "rate_limit", blockedUntil: Date.now() + 3_600_000 });
		await block("work", "old-b", { blockReason: "auth_error" });
		await block("spare", "old-c", { blockReason: "account_disabled" });

		// when
		const accounts = await getCredentialAccounts(storage, PROVIDER, {}, repository);
		const relogin = (name: string) => `/gpt-account login ${name}`;
		const rendered = Object.fromEntries(
			accounts.map((account) => [account.name, describeAccountHealth(account, relogin)]),
		);

		// then
		expect(accounts.map((account) => [account.name, account.blockReason])).toEqual([
			["default", "rate_limit"],
			["work", "auth_error"],
			["spare", "account_disabled"],
		]);
		expect(accounts[0]?.blockedUntil).toBeGreaterThan(Date.now());
		expect(rendered.default).toMatch(/^blocked: usage limit until \d{4}-\d\d-\d\dT/);
		expect(rendered.work).toContain("/gpt-account login work");
		expect(rendered.spare).toContain("/gpt-account login spare");
		expect(new Set(Object.values(rendered)).size).toBe(3);
	});

	it("an environment account's auth block names its variable, not a command that refuses env accounts", () => {
		const text = describeAccountHealth(
			{ name: "env-key", source: "env", blocked: true, blockReason: "auth_error" },
			(name) => `/gpt-account login ${name}`,
		);
		expect(text).not.toContain("/gpt-account login");
		expect(text).toContain("environment variable");
	});

	it("an available account and a usage limit with a known reset render as such", () => {
		expect(describeAccountHealth({ name: "a", blocked: false })).toBe("available");
		expect(describeAccountHealth({ name: "a", blocked: true, blockReason: "rate_limit", blockedUntil: UNTIL })).toBe(
			"blocked: usage limit until 2026-10-13T20:00:00.000Z",
		);
	});
});

describe("senpi#3216 /gpt-account login <id>", () => {
	it("logs an existing account in again in place: same id, display name and pin, new material, block cleared", async () => {
		// given - 'default' (displayed as Personal) carries an auth block.
		await seedAccounts();
		await block("default", "old-a", { blockReason: "auth_error" });
		await repository.mutateSlotState(PROVIDER, "stored", "default", (current) => ({ ...current, failureCount: 10 }));
		const { ctx, notices } = createLoginCommandContext(storage, dir, async () => undefined);
		const committed: string[] = [];
		// Stands in for the real runtime: the fresh login is appended as a new slot, then reported by name.
		Object.assign(ctx.modelRegistry.modelRuntime, {
			login: async (
				provider: string,
				_method: string,
				interaction: {
					onAccountCommitted?: (r: { providerId: string; name: string; origin: "generated" }) => void;
				},
			) => {
				let name = "";
				await storage.modify(provider, async (current) =>
					appendLoginSlot(current as PooledCredential, { type: "oauth", ...oauth("new-a") }, (allocated) => {
						name = allocated;
					}),
				);
				committed.push(name);
				interaction.onAccountCommitted?.({ providerId: provider, name, origin: "generated" });
			},
		});

		// when
		await registerCommand("gpt-account", (pi) => gptAccountExtension(pi)).handler("login default", ctx);

		// then
		const stored = (await storage.read(PROVIDER)) as PooledCredential;
		expect(stored.accounts?.map((slot) => [slot.name, slot.displayName, slot.access])).toEqual([
			["default", "Personal", "new-a"],
			["work", undefined, "old-b"],
			["spare", undefined, "old-c"],
		]);
		expect(stored.pinned).toBe("work");
		expect(stored.type === "oauth" ? stored.access : undefined).toBe("new-a");
		const accounts = await getCredentialAccounts(storage, PROVIDER, {}, repository);
		expect(accounts.find((account) => account.name === "default")?.blocked).toBe(false);
		expect((await repository.listSlots(PROVIDER, "stored")).default).toBeUndefined();
		expect(committed).toHaveLength(1);
		expect(notices.at(-1)?.type).toBe("info");
	});

	it("refuses an id that is not an account, without starting a login", async () => {
		// given
		await seedAccounts();
		const { ctx, notices, logins } = createLoginCommandContext(storage, dir, async () => undefined);

		// when
		await registerCommand("gpt-account", (pi) => gptAccountExtension(pi)).handler("login nope", ctx);

		// then
		expect(logins).toEqual([]);
		expect(notices.at(-1)?.type).toBe("error");
	});
});
