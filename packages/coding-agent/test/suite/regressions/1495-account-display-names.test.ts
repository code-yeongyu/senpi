import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	accountLabel,
	listSlots,
	mergeRefreshedSlot,
	type PooledCredential,
} from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { getCredentialAccounts, renameCredentialAccount } from "../../../src/core/credential-accounts.ts";
import { subscribeProviderAccountEvents } from "../../../src/core/extensions/builtin/claude-sdk-oauth/account-events.ts";
import { getProviderAccounts } from "../../../src/core/extensions/builtin/claude-sdk-oauth/account-management.ts";
import { emptyCredential } from "../../../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(provider: string) {
	const dir = mkdtempSync(join(tmpdir(), "account-display-name-"));
	dirs.push(dir);
	const path = join(dir, "auth.json");
	const base =
		provider === "claude-sdk-oauth"
			? emptyCredential()
			: { type: "oauth" as const, access: "fake-a", refresh: "fake-r", expires: 4102444800000 };
	const credential = {
		...base,
		pinned: "default",
		accounts: [
			{ name: "default", access: "fake-a", refresh: "fake-r", expires: 4102444800000, source: "login" as const },
			{
				name: "second",
				access: "fake-b",
				refresh: "fake-s",
				expires: 4102444800000,
				source: "import" as const,
				blockedUntil: 4102444800000,
			},
		],
	};
	const storage = AuthStorage.create(path);
	storage.set(provider, credential);
	return { storage, path, credential };
}

// senpi#1495: display names are metadata, never account identity.
describe.each(["openai-codex", "claude-sdk-oauth"])("%s display names", (provider) => {
	it("round trips trimmed metadata, preserves every other field, and clears without removing the slot", async () => {
		const { storage, path, credential } = fixture(provider);
		await renameCredentialAccount(storage, provider, "default", "  Personal account  ");
		const saved = AuthStorage.create(path).get(provider) as PooledCredential;
		expect(saved).toEqual({
			...credential,
			accounts: [{ ...credential.accounts[0], displayName: "Personal account" }, credential.accounts[1]],
		});
		expect(accountLabel(listSlots(saved)[0])).toBe("Personal account (default)");
		await renameCredentialAccount(storage, provider, "default", null);
		expect(JSON.parse(readFileSync(path, "utf8"))[provider]).toEqual(credential);
	});

	it("rejects empty, unsafe, oversized, missing, and duplicate labels without a write or event", async () => {
		const { storage, path } = fixture(provider);
		await renameCredentialAccount(storage, provider, "second", "Work");
		let before = readFileSync(path, "utf8");
		const events: unknown[] = [];
		const unsubscribe = subscribeProviderAccountEvents((event) => events.push(event));
		try {
			for (const label of [
				"",
				"   ",
				"bad\u001b[31m",
				"line\nlabel",
				"spoof\u202e",
				"\u3164",
				"\u2800\u2800",
				"\u0301abc",
				"中".repeat(33),
				"🎉".repeat(17),
			]) {
				await expect(renameCredentialAccount(storage, provider, "default", label)).rejects.toThrow(
					/1-32 terminal columns/,
				);
				expect(readFileSync(path, "utf8")).toBe(before);
			}
			// Case and whitespace duplicates of the stored "Work" label.
			for (const label of ["work", " Work "]) {
				await expect(renameCredentialAccount(storage, provider, "default", label)).rejects.toThrow(/already used/);
				expect(readFileSync(path, "utf8")).toBe(before);
			}
			// Cyrillic \u0412 renders as Latin B: same glyph, different code point.
			await renameCredentialAccount(storage, provider, "second", "Bork");
			before = readFileSync(path, "utf8");
			events.length = 0;
			await expect(renameCredentialAccount(storage, provider, "default", "\u0412ork")).rejects.toThrow(
				/already used/,
			);
			await expect(renameCredentialAccount(storage, provider, "missing", "Valid")).rejects.toThrow(/not found/);
			expect(readFileSync(path, "utf8")).toBe(before);
			expect(events).toEqual([]);
		} finally {
			unsubscribe();
		}
	});

	it("serializes duplicate claims against the latest persisted slots", async () => {
		const { storage, path } = fixture(provider);
		const secondWriter = AuthStorage.create(path);
		const results = await Promise.allSettled([
			renameCredentialAccount(storage, provider, "default", "Shared"),
			renameCredentialAccount(secondWriter, provider, "second", "Shared"),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		const saved = AuthStorage.create(path).get(provider) as PooledCredential;
		expect(listSlots(saved).filter((slot) => slot.displayName === "Shared")).toHaveLength(1);
	});

	it("exposes only safe descriptors and keeps labels through named refresh", async () => {
		const { storage } = fixture(provider);
		await renameCredentialAccount(storage, provider, "default", "Personal");
		await storage.modify(provider, async (current) =>
			mergeRefreshedSlot(current!, "default", {
				type: "oauth",
				access: "fake-rotated",
				refresh: "fake-next",
				expires: 4102444800001,
			}),
		);
		const summaries = await getCredentialAccounts(storage, provider, {});
		expect(summaries).toEqual([
			{ name: "default", displayName: "Personal", source: "login", blocked: false, pinned: true },
			{ name: "second", source: "import", blocked: true, pinned: false },
		]);
		if (provider === "claude-sdk-oauth") expect(getProviderAccounts(storage, provider, {})).toEqual(summaries);
		expect(JSON.stringify(summaries)).not.toMatch(/fake-|access|refresh|expires|headers/);
	});
});

it("promotes a legacy saved flat slot only on rename and never materializes environment credentials", async () => {
	const storage = AuthStorage.inMemory({
		"openai-codex": { type: "oauth", access: "fake-a", refresh: "fake-r", expires: 4102444800000 },
	});
	expect(accountLabel(listSlots(storage.get("openai-codex"))[0])).toBe("default");
	expect(storage.get("openai-codex")).not.toHaveProperty("accounts");
	await renameCredentialAccount(storage, "openai-codex", "default", "Legacy");
	expect(listSlots(storage.get("openai-codex"))[0].displayName).toBe("Legacy");
	const empty = AuthStorage.inMemory();
	await expect(renameCredentialAccount(empty, "claude-sdk-oauth", "env", "Environment")).rejects.toThrow(
		/not found|No stored credential/,
	);
	expect(empty.getAll()).toEqual({});
});

// senpi#1495 review finding 4: the sentinel guard must be keyed on the
// credential shape, not on the literal provider id, because cursor-cli-oauth
// defines the identical `-managed` sentinel envelope; a rename against that
// shape must not fabricate a `default` login slot carrying the sentinel strings.
it("refuses to promote a provider-managed sentinel flat credential for any provider lane", async () => {
	for (const provider of ["claude-sdk-oauth", "cursor-cli-oauth"]) {
		const storage = AuthStorage.inMemory({
			[provider]: {
				type: "oauth",
				access: `${provider}-managed`,
				refresh: `${provider}-managed`,
				expires: 4_102_444_800_000,
			},
		});
		await expect(renameCredentialAccount(storage, provider, "default", "My cursor")).rejects.toThrow(/not found/);
		expect(storage.get(provider)).toEqual({
			type: "oauth",
			access: `${provider}-managed`,
			refresh: `${provider}-managed`,
			expires: 4_102_444_800_000,
		});
	}
});

it("omits unsafe hand-written metadata from labels and summaries", async () => {
	const { storage } = fixture("openai-codex");
	storage.setSlot("openai-codex", { name: "default", displayName: "unsafe\u001b[31m" });
	const summaries = await getCredentialAccounts(storage, "openai-codex", {});
	expect(summaries[0]).not.toHaveProperty("displayName");
	expect(accountLabel(listSlots(storage.get("openai-codex"))[0])).toBe("default");
});

it("allows the same display name in different providers", async () => {
	const storage = AuthStorage.inMemory();
	for (const provider of ["openai-codex", "claude-sdk-oauth"]) {
		storage.set(provider, {
			type: "oauth",
			access: "fake-a",
			refresh: "fake-r",
			expires: 1,
			accounts: [{ name: "default", source: "login", access: "fake-a", refresh: "fake-r", expires: 1 }],
		});
		await renameCredentialAccount(storage, provider, "default", "Personal");
		expect((await getCredentialAccounts(storage, provider, {}))[0].displayName).toBe("Personal");
	}
});
