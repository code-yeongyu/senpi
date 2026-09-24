import { describe, expect, test } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { envApiKeyAuth } from "../src/auth/helpers.ts";
import {
	appendLoginSlot,
	type Credential,
	type CredentialSlot,
	isManagedSentinelSlot,
	listSlots,
	managedSentinelMaterial,
	mergeRefreshed,
	type PooledCredential,
	removeSlot,
	repairManagedSentinelSlots,
	upsertSlot,
} from "../src/auth/pool/slots.ts";
import { resolveProviderAuth } from "../src/auth/resolve.ts";
import type { OAuthCredential } from "../src/auth/types.ts";
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

	test("a provider-owned pool never rewinds a sibling the browser round trip left behind", () => {
		// The provider builds its pool from a snapshot read BEFORE the interactive
		// login; the value under the credential lock at commit time may have moved
		// on since (a sibling rotated its token, or earned a rate-limit block).
		type BlockableSlot = CredentialSlot & { blockedUntil?: number; blockReason?: string };
		const snapshot = sentinelPool();
		const rotated: BlockableSlot = {
			name: "default",
			source: "login",
			access: "rotated-access",
			refresh: "rotated-refresh",
			expires: 4_102_444_800_000,
			blockedUntil: 4_102_444_800_000,
			blockReason: "rate_limit",
		};
		const authoritative: PooledCredential = {
			...snapshot,
			pinned: "default",
			accounts: [rotated],
		};
		const providerLoginResult: PooledCredential = {
			...snapshot,
			accounts: [
				...(snapshot.accounts ?? []),
				{ name: "account-2", source: "login", access: "real-b", refresh: "refresh-b", expires: 999 },
			],
		};

		const next = appendLoginSlot(authoritative, providerLoginResult) as PooledCredential;

		expect(names(next)).toEqual(["default", "account-2"]);
		const stored = next.accounts?.find((slot) => slot.name === "default");
		expect(stored).toEqual(authoritative.accounts?.[0]);
	});

	test("a provider-owned pool onto a flat current keeps the whole-write shape", () => {
		const flat: PooledCredential = { type: "oauth", access: "legacy-a", refresh: "legacy-r", expires: 999 };
		const providerLoginResult: PooledCredential = {
			type: "oauth",
			access: "legacy-a",
			refresh: "legacy-r",
			expires: 999,
			accounts: [{ name: "default", source: "login", access: "fresh-a", refresh: "fresh-r", expires: 999 }],
		};

		const next = appendLoginSlot(flat, providerLoginResult);

		expect(next).toEqual(providerLoginResult);
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

describe("re-login with a known account identity", () => {
	const alice = { id: "account-alice/org-1", email: "alice@example.test" };
	const bob = { id: "account-bob/org-1", email: "bob@example.test" };

	function oauthLogin(tag: string, identity?: { id: string; email?: string }): OAuthCredential {
		return {
			type: "oauth",
			access: `${tag}-access`,
			refresh: `${tag}-refresh`,
			expires: 100,
			...(identity ? { identity } : {}),
		};
	}

	function aliceAndBobPool(): PooledCredential {
		return {
			type: "oauth",
			access: "alice-old-access",
			refresh: "alice-old-refresh",
			expires: 1,
			identity: alice,
			accounts: [
				{
					name: "default",
					source: "login",
					displayName: "Personal",
					access: "alice-old-access",
					refresh: "alice-old-refresh",
					expires: 1,
					identity: alice,
				},
				{
					name: "login-2",
					source: "login",
					access: "bob-access",
					refresh: "bob-refresh",
					expires: 1,
					identity: bob,
				},
			],
			pinned: "default",
		};
	}

	test("a login with a new identity is appended and keeps that identity on its slot", () => {
		const next = appendLoginSlot(aliceAndBobPool(), oauthLogin("carol", { id: "account-carol/org-1" }));

		expect(listSlots(next).map((slot) => slot.name)).toEqual(["default", "login-2", "login-3"]);
		expect(listSlots(next).at(-1)).toMatchObject({ access: "carol-access", identity: { id: "account-carol/org-1" } });
	});

	test("a login with a stored identity refreshes that slot in place instead of appending login-N", () => {
		const allocations: [string, string][] = [];

		const next = appendLoginSlot(aliceAndBobPool(), oauthLogin("bob-new", bob), (name, origin) =>
			allocations.push([name, origin]),
		) as PooledCredential;

		expect(listSlots(next).map((slot) => slot.name)).toEqual(["default", "login-2"]);
		expect(listSlots(next).find((slot) => slot.name === "login-2")).toEqual({
			name: "login-2",
			source: "login",
			access: "bob-new-access",
			refresh: "bob-new-refresh",
			expires: 100,
			identity: bob,
		});
		expect(allocations).toEqual([["login-2", "updated"]]);
		// login-2 was not the flat projection, so the flat fields and the pin stay on the default account
		expect(next).toMatchObject({ access: "alice-old-access", refresh: "alice-old-refresh", pinned: "default" });
	});

	test("refreshing the projected slot in place also rotates the flat fields and keeps its display name", () => {
		const next = appendLoginSlot(aliceAndBobPool(), oauthLogin("alice-new", alice)) as PooledCredential;

		expect(next).toMatchObject({
			access: "alice-new-access",
			refresh: "alice-new-refresh",
			expires: 100,
			identity: alice,
		});
		expect(listSlots(next).find((slot) => slot.name === "default")).toMatchObject({
			displayName: "Personal",
			access: "alice-new-access",
			refresh: "alice-new-refresh",
		});
	});

	test("an in-place re-login drops block state persisted on the replaced material", () => {
		const current = aliceAndBobPool();
		current.accounts = current.accounts?.map((slot) =>
			slot.name === "login-2" ? { ...slot, blockReason: "auth_error", blockedUntil: 9_999_999_999_999 } : slot,
		);

		const refreshed = listSlots(appendLoginSlot(current, oauthLogin("bob-new", bob)) as PooledCredential).find(
			(slot) => slot.name === "login-2",
		);

		expect(refreshed).not.toHaveProperty("blockReason");
		expect(refreshed).not.toHaveProperty("blockedUntil");
	});

	test("a legacy flat credential with the same identity is refreshed in place and stays flat", () => {
		const current: Credential = { ...oauthLogin("alice-old", alice), expires: 1 };

		const next = appendLoginSlot(current, oauthLogin("alice-new", alice));

		expect(next).toEqual({ ...oauthLogin("alice-new", alice) });
	});

	test("slots without a recorded identity never absorb a login, so older pools keep appending", () => {
		const current: PooledCredential = {
			type: "oauth",
			access: "old-access",
			refresh: "old-refresh",
			expires: 1,
			accounts: [{ name: "default", source: "login", access: "old-access", refresh: "old-refresh", expires: 1 }],
		};

		const next = appendLoginSlot(current, oauthLogin("new", alice));

		expect(listSlots(next).map((slot) => slot.name)).toEqual(["default", "login-2"]);
	});

	test("a login without an identity keeps appending even when stored slots carry one", () => {
		expect(listSlots(appendLoginSlot(aliceAndBobPool(), oauthLogin("anon"))).map((slot) => slot.name)).toEqual([
			"default",
			"login-2",
			"login-3",
		]);
	});

	test("a malformed identity is ignored rather than matched or stored", () => {
		const next = appendLoginSlot(aliceAndBobPool(), {
			...oauthLogin("odd"),
			identity: { id: "" },
		} as Credential);

		expect(listSlots(next).map((slot) => slot.name)).toEqual(["default", "login-2", "login-3"]);
		expect(listSlots(next).at(-1)).not.toHaveProperty("identity");
	});

	test("a token refresh of a flat single-account credential keeps its identity", () => {
		const current: Credential = oauthLogin("alice-old", alice);

		expect(mergeRefreshed(current, oauthLogin("alice-rotated"))).toEqual(oauthLogin("alice-rotated", alice));
	});

	test("removing the projected slot re-projects the survivor's identity onto the flat fields", () => {
		const next = removeSlot(aliceAndBobPool(), "default") as PooledCredential;

		expect(next).toMatchObject({ access: "bob-access", identity: bob });
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

describe("provider-managed sentinel slot repair", () => {
	const sentinel = managedSentinelMaterial("anthropic-subscription");

	function poisoned(): PooledCredential {
		return {
			type: "oauth",
			access: sentinel,
			refresh: sentinel,
			expires: 4_102_444_800_000,
			pinned: "default",
			accounts: [
				{ name: "default", access: "real-access", refresh: "real-refresh", expires: 999, source: "login" },
				{ name: "login-2", access: sentinel, refresh: sentinel, expires: 4_102_444_800_000, source: "login" },
			],
		};
	}

	test("recognizes a slot carrying the provider's managed sentinel in both fields", () => {
		expect(
			isManagedSentinelSlot("anthropic-subscription", { name: "login-2", access: sentinel, refresh: sentinel }),
		).toBe(true);
		expect(
			isManagedSentinelSlot("anthropic-subscription", { name: "default", access: "real-access", refresh: sentinel }),
		).toBe(false);
		expect(isManagedSentinelSlot("other-provider", { name: "default", access: sentinel, refresh: sentinel })).toBe(
			false,
		);
	});

	test("repair drops a poisoned slot and clears a pin that pointed at one", () => {
		const poisonedPinnedAtJunk: PooledCredential = { ...poisoned(), pinned: "login-2" };
		const repaired = repairManagedSentinelSlots("anthropic-subscription", poisonedPinnedAtJunk);
		expect(repaired).toBeDefined();
		expect(listSlots(repaired).map((slot) => slot.name)).toEqual(["default"]);
		expect(repaired?.pinned).toBeUndefined();
		expect(repairManagedSentinelSlots("anthropic-subscription", poisoned())?.pinned).toBe("default");
	});

	test("a clean pool or flat credential is a no-op so no storage is rewritten", () => {
		const clean = removeSlot(poisoned(), "login-2") as PooledCredential;
		expect(repairManagedSentinelSlots("anthropic-subscription", clean)).toBeUndefined();
		expect(
			repairManagedSentinelSlots("anthropic-subscription", { type: "oauth", access: "a", refresh: "r", expires: 1 }),
		).toBe(undefined);
	});
});
