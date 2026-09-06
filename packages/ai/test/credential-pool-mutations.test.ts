import { describe, expect, test } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { envApiKeyAuth } from "../src/auth/helpers.ts";
import {
	appendLoginSlot,
	type Credential,
	type CredentialSlot,
	listSlots,
	type PooledCredential,
	removeSlot,
	upsertSlot,
} from "../src/auth/pool/slots.ts";
import { resolveProviderAuth } from "../src/auth/resolve.ts";
import { createProvider, type Provider } from "../src/models.ts";

describe("credential pool slot algebra", () => {
	function pooledApiKey(): PooledCredential {
		return {
			type: "api_key",
			key: "primary-key",
			accounts: [
				{ name: "default", key: "primary-key", source: "login" },
				{ name: "work", key: "work-key", source: "login" },
			],
			pinned: "work",
		};
	}

	function names(credential: PooledCredential | undefined): string[] {
		return listSlots(credential).map((slot) => slot.name);
	}

	test("a flat api_key credential reads as a one-slot pool", () => {
		const flat: Credential = { type: "api_key", key: "legacy-key" };
		expect(listSlots(flat)).toEqual([{ name: "default", source: "login", key: "legacy-key" }]);
	});

	test("a flat oauth credential reads as a one-slot pool carrying its tokens", () => {
		const flat: Credential = { type: "oauth", access: "a", refresh: "r", expires: 123 };
		expect(listSlots(flat)).toEqual([{ name: "default", source: "login", access: "a", refresh: "r", expires: 123 }]);
	});

	test("upsertSlot replaces one slot and keeps its siblings", () => {
		const next = upsertSlot(pooledApiKey(), { name: "default", key: "rotated", source: "login" });
		expect(names(next)).toEqual(["default", "work"]);
		expect(listSlots(next).find((slot) => slot.name === "work")?.key).toBe("work-key");
	});

	test("upsertSlot appends an unseen slot", () => {
		expect(names(upsertSlot(pooledApiKey(), { name: "personal", key: "p", source: "login" }))).toEqual([
			"default",
			"work",
			"personal",
		]);
	});

	test("upsertSlot preserves the pin", () => {
		expect(upsertSlot(pooledApiKey(), { name: "default", key: "rotated", source: "login" }).pinned).toBe("work");
	});

	test("upsertSlot leaves the flat credential usable by a build predating pools", () => {
		const next = upsertSlot({ type: "api_key", key: "legacy-key" }, { name: "second", key: "s", source: "login" });
		expect(next).toMatchObject({ type: "api_key", key: "legacy-key" });
		expect(names(next)).toEqual(["default", "second"]);
	});

	test("appendLoginSlot promotes a legacy flat credential before adding a login", () => {
		const current: Credential = { type: "oauth", access: "first-access", refresh: "first-refresh", expires: 1 };
		const next = appendLoginSlot(current, {
			type: "oauth",
			access: "second-access",
			refresh: "second-refresh",
			expires: 2,
		});

		expect(next).toMatchObject({ type: "oauth", access: "first-access", refresh: "first-refresh", expires: 1 });
		expect(names(next)).toEqual(["default", "login-2"]);
		expect(listSlots(next).find((slot) => slot.name === "login-2")).toMatchObject({
			access: "second-access",
			refresh: "second-refresh",
			expires: 2,
		});
	});

	test("removeSlot deletes only the named slot", () => {
		expect(names(removeSlot(pooledApiKey(), "default"))).toEqual(["work"]);
	});

	test("removeSlot clears a pin naming the removed slot", () => {
		expect(removeSlot(pooledApiKey(), "work")?.pinned).toBeUndefined();
	});

	test("removeSlot drops the credential once its last slot is gone", () => {
		const single: PooledCredential = {
			type: "api_key",
			key: "only",
			accounts: [{ name: "default", key: "only", source: "login" }],
		};
		expect(removeSlot(single, "default")).toBeUndefined();
	});

	test("removeSlot re-projects the flat fields from the survivor when the projected slot is removed", () => {
		const promoted = appendLoginSlot(
			{ type: "oauth", access: "legacy-access", refresh: "legacy-refresh", expires: 1 },
			{ type: "oauth", access: "second-access", refresh: "second-refresh", expires: 2 },
		) as PooledCredential;

		const next = removeSlot(promoted, "default");

		expect(names(next)).toEqual(["login-2"]);
		expect(next).toMatchObject({
			type: "oauth",
			access: "second-access",
			refresh: "second-refresh",
			expires: 2,
		});
	});

	test("removeSlot leaves the flat projection alone when a non-projected slot is removed", () => {
		const promoted = appendLoginSlot(
			{ type: "oauth", access: "legacy-access", refresh: "legacy-refresh", expires: 1 },
			{ type: "oauth", access: "second-access", refresh: "second-refresh", expires: 2 },
		) as PooledCredential;

		const next = removeSlot(promoted, "login-2");

		expect(names(next)).toEqual(["default"]);
		expect(next).toMatchObject({
			type: "oauth",
			access: "legacy-access",
			refresh: "legacy-refresh",
			expires: 1,
		});
	});

	test("removeSlot re-projects an api_key survivor when the projected slot is removed", () => {
		const promoted = appendLoginSlot({ type: "api_key", key: "legacy-key" }, { type: "api_key", key: "second-key" });

		const next = removeSlot(promoted, "default");

		expect(names(next)).toEqual(["login-2"]);
		expect(next).toMatchObject({ type: "api_key", key: "second-key" });
	});

	test("upsertSlot rejects a slot name that could collide with path syntax", () => {
		const slot = { name: "../escape", key: "k", source: "login" } as CredentialSlot;
		expect(() => upsertSlot(pooledApiKey(), slot)).toThrow(/Invalid account name/);
	});

	function sentinelPool(): PooledCredential {
		return {
			type: "oauth",
			access: "claude-sdk-oauth-managed",
			refresh: "claude-sdk-oauth-managed",
			expires: 4_102_444_800_000,
			accounts: [{ name: "default", source: "login", access: "real-a", refresh: "refresh-a", expires: 999 }],
		};
	}

	test("appendLoginSlot returns a provider-owned pooled login result unchanged", () => {
		const current = sentinelPool();
		const providerLoginResult: PooledCredential = {
			...current,
			accounts: [
				...listSlots(current),
				{ name: "account-2", source: "login", access: "real-b", refresh: "refresh-b", expires: 999 },
			],
		};

		const next = appendLoginSlot(current, providerLoginResult);

		expect(next).toEqual(providerLoginResult);
		expect(names(next)).toEqual(["default", "account-2"]);
		expect(listSlots(next).at(-1)?.access).toBe("real-b");
	});

	test("appendLoginSlot still appends an unnamed flat oauth credential as login-2", () => {
		const flat: Credential = { type: "oauth", access: "fresh-access", refresh: "fresh-refresh", expires: 999 };

		const next = appendLoginSlot(sentinelPool(), flat);

		expect(names(next)).toEqual(["default", "login-2"]);
		expect(listSlots(next).at(-1)).toMatchObject({ access: "fresh-access", refresh: "fresh-refresh" });
	});

	test("appendLoginSlot still appends an unnamed flat api_key credential", () => {
		const next = appendLoginSlot(pooledApiKey(), { type: "api_key", key: "third-key" });

		expect(names(next)).toEqual(["default", "work", "login-2"]);
		expect(listSlots(next).at(-1)?.key).toBe("third-key");
	});

	test("appendLoginSlot without a current credential writes the flat credential as-is", () => {
		const flat: Credential = { type: "api_key", key: "only-key" };

		expect(appendLoginSlot(undefined, flat)).toBe(flat);
	});
});

describe("ordinary auth resolution after removing a promoted account", () => {
	const authContext = { env: async () => undefined, fileExists: async () => false };
	const FUTURE = 4_102_444_800_000;

	const provider: Provider = createProvider({
		id: "removeoauth",
		name: "Remove OAuth",
		baseUrl: "https://removeoauth.example",
		auth: {
			apiKey: envApiKeyAuth("Remove OAuth API key", ["REMOVEOAUTH_API_KEY"]),
			oauth: {
				name: "Remove OAuth",
				login: async () => ({ type: "oauth", access: "a", refresh: "r", expires: FUTURE }),
				refresh: async (credential) => credential,
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
		models: [],
		api: "openai-responses" as never,
	});

	function promotedPool(): PooledCredential {
		return appendLoginSlot(
			{ type: "oauth", access: "legacy-access", refresh: "legacy-refresh", expires: FUTURE },
			{ type: "oauth", access: "second-access", refresh: "second-refresh", expires: FUTURE },
		) as PooledCredential;
	}

	test("removing the promoted default makes login-2 the credential ordinary requests use", async () => {
		const store = new InMemoryCredentialStore();
		const remaining = removeSlot(promotedPool(), "default");
		if (!remaining) throw new Error("removeSlot dropped a pool that still had a slot");
		await store.modify("removeoauth", async () => remaining);

		const resolved = await resolveProviderAuth(provider, store, authContext);

		expect(resolved?.auth.apiKey).toBe("second-access");
	});

	test("removing login-2 keeps the promoted default the credential ordinary requests use", async () => {
		const store = new InMemoryCredentialStore();
		const remaining = removeSlot(promotedPool(), "login-2");
		if (!remaining) throw new Error("removeSlot dropped a pool that still had a slot");
		await store.modify("removeoauth", async () => remaining);

		const resolved = await resolveProviderAuth(provider, store, authContext);

		expect(resolved?.auth.apiKey).toBe("legacy-access");
	});
});
