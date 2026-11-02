import { type Credential, type CredentialStore, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	addAccount,
	assertSentinelInvariant,
	assertValidAccountName,
	type CursorCliAccountSlot,
	type CursorCliOauthCredential,
	emptyCredential,
	listAccounts,
	pinAccount,
	refreshSlot,
	removeAccount,
	SENTINEL_OAUTH_FIELDS,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/accounts.ts";

const providerId = "cursor-cli-oauth";

const account: CursorCliAccountSlot = {
	name: "default",
	access: "slot-access",
	refresh: "slot-refresh",
	expires: 4_102_444_800_000,
	source: "login",
};

async function storeWith(credential: Credential): Promise<InMemoryCredentialStore> {
	const store = new InMemoryCredentialStore();
	await store.modify(providerId, async () => credential);
	return store;
}

function credentialWith(...accounts: CursorCliAccountSlot[]): CursorCliOauthCredential {
	return accounts.reduce(addAccount, emptyCredential());
}

describe("Cursor CLI OAuth account slots", () => {
	it("adds, lists, pins, and removes accounts without exposing tokens at the top level", () => {
		let credential = addAccount(emptyCredential(), account);
		credential = addAccount(credential, {
			...account,
			name: "work_2",
			access: "work-access",
			refresh: "work-refresh",
			source: "import",
		});

		expect(listAccounts(credential).map((slot) => slot.name)).toEqual(["default", "work_2"]);
		credential = pinAccount(credential, "work_2");
		expect(credential.pinned).toBe("work_2");
		credential = removeAccount(credential, "work_2");
		expect(listAccounts(credential)).toEqual([account]);
		expect(credential.pinned).toBeUndefined();
		expect(credential.access).toBe(SENTINEL_OAUTH_FIELDS.access);
		expect(credential.refresh).toBe(SENTINEL_OAUTH_FIELDS.refresh);
	});

	it("rejects duplicate account names", () => {
		const credential = addAccount(emptyCredential(), account);
		expect(() => addAccount(credential, account)).toThrowError(/already exists/i);
	});

	it.each(["", "-leading", "_leading", "contains space", "dot.name", "a".repeat(65)])(
		"rejects invalid account name %j",
		(name) => {
			expect(() => assertValidAccountName(name)).toThrowError(/invalid account name/i);
		},
	);

	it("accepts names matching the complete account-name contract", () => {
		expect(() => assertValidAccountName("A0_-z")).not.toThrow();
		expect(() => assertValidAccountName("a".repeat(64))).not.toThrow();
	});

	it("enforces the fixed top-level sentinel invariant", () => {
		const credential = credentialWith(account);
		expect(SENTINEL_OAUTH_FIELDS).toEqual({
			access: "cursor-cli-oauth-managed",
			refresh: "cursor-cli-oauth-managed",
			expires: 4_102_444_800_000,
		});
		expect(() => assertSentinelInvariant(credential)).not.toThrow();
		expect(() => assertSentinelInvariant({ ...credential, access: account.access })).toThrowError(/sentinel/i);
		expect(JSON.stringify(credential)).toContain(account.access);
		expect(credential.access).not.toBe(account.access);
	});

	it("refreshes an expired slot and preserves every other slot", async () => {
		const expired = { ...account, expires: 0 };
		const other = {
			...account,
			name: "other",
			access: "other-access",
			refresh: "other-refresh",
		};
		const store = await storeWith(credentialWith(expired, other));
		const signal = new AbortController().signal;
		const refresher = vi.fn(async (refreshToken: string, receivedSignal: AbortSignal) => {
			expect(refreshToken).toBe("slot-refresh");
			expect(receivedSignal).toBe(signal);
			return {
				access: "new-access",
				refresh: "new-refresh",
				expires: Date.now() + 60_000,
			};
		});

		const result = await refreshSlot(store, providerId, "default", refresher, signal);
		const credential = result as CursorCliOauthCredential;
		expect(refresher).toHaveBeenCalledOnce();
		expect(listAccounts(credential)).toEqual([
			{
				...expired,
				access: "new-access",
				refresh: "new-refresh",
				expires: expect.any(Number),
			},
			other,
		]);
		expect(() => assertSentinelInvariant(credential)).not.toThrow();
	});

	it("does not refresh an unexpired slot", async () => {
		const store = await storeWith(credentialWith({ ...account, expires: Date.now() + 60_000 }));
		const refresher = vi.fn(async () => ({
			access: "new",
			refresh: "new",
			expires: 1,
		}));

		await refreshSlot(store, providerId, "default", refresher, new AbortController().signal);

		expect(refresher).not.toHaveBeenCalled();
	});

	it("ignores non-oauth credentials passed to refreshSlot", async () => {
		const apiKey: Credential = { type: "api_key", key: "native-key" };
		const store = await storeWith(apiKey);
		const refresher = vi.fn(async () => ({
			access: "new",
			refresh: "new",
			expires: 1,
		}));

		const result = await refreshSlot(store, providerId, "default", refresher, new AbortController().signal);

		expect(result).toEqual(apiKey);
		expect(refresher).not.toHaveBeenCalled();
		expect(await store.read(providerId)).toEqual(apiKey);
	});

	it("uses the credential supplied under the store lock when the slot list changed", async () => {
		const changed = credentialWith({
			...account,
			name: "replacement",
			expires: 0,
		});
		const modifiedProviders: string[] = [];
		const store: CredentialStore = {
			async read() {
				throw new Error("refreshSlot must not read outside modify");
			},
			async list() {
				return [];
			},
			async delete() {},
			async modify(requestedProviderId, fn) {
				modifiedProviders.push(requestedProviderId);
				return fn(changed);
			},
		};
		const refresher = vi.fn(async () => ({
			access: "new",
			refresh: "new",
			expires: 1,
		}));

		const result = await refreshSlot(store, providerId, "default", refresher, new AbortController().signal);

		expect(result).toEqual(changed);
		expect(refresher).not.toHaveBeenCalled();
		expect(modifiedProviders).toEqual([providerId]);
	});

	it("never reads or writes the native cursor credential entry", async () => {
		const touchedProviders: string[] = [];
		let current: Credential | undefined = credentialWith({
			...account,
			expires: 0,
		});
		const store: CredentialStore = {
			async read(requestedProviderId) {
				touchedProviders.push(`read:${requestedProviderId}`);
				return current;
			},
			async list() {
				return [];
			},
			async delete(requestedProviderId) {
				touchedProviders.push(`delete:${requestedProviderId}`);
				current = undefined;
			},
			async modify(requestedProviderId, fn) {
				touchedProviders.push(`modify:${requestedProviderId}`);
				current = await fn(current);
				return current;
			},
		};

		let credential = addAccount(emptyCredential(), account);
		credential = pinAccount(credential, account.name);
		credential = removeAccount(credential, account.name);
		listAccounts(credential);
		await refreshSlot(
			store,
			providerId,
			account.name,
			async () => ({
				access: "new",
				refresh: "new",
				expires: Date.now() + 60_000,
			}),
			new AbortController().signal,
		);

		expect(touchedProviders).toEqual([`modify:${providerId}`]);
		expect(touchedProviders.some((entry) => entry.endsWith(":cursor"))).toBe(false);
	});
});
