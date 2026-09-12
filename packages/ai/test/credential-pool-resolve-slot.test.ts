import { describe, expect, test } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { envApiKeyAuth } from "../src/auth/helpers.ts";
import { listSlots, type PooledCredential } from "../src/auth/pool/slots.ts";
import { resolveProviderAuth } from "../src/auth/resolve.ts";
import type { OAuthCredential } from "../src/auth/types.ts";
import { createProvider, type Provider } from "../src/models.ts";

const authContext = { env: async () => undefined, fileExists: async () => false };

function pooledApiKeyEntry(): PooledCredential {
	return {
		type: "api_key",
		key: "primary-key",
		accounts: [
			{ name: "default", key: "primary-key", source: "login" },
			{ name: "work", key: "work-key", source: "login" },
		],
	};
}

const apiKeyProvider: Provider = createProvider({
	id: "slottest",
	name: "Slot Test",
	baseUrl: "https://slottest.example/v1",
	auth: { apiKey: envApiKeyAuth("Slot Test API key", ["SLOTTEST_API_KEY"]) },
	models: [],
	api: "openai-responses" as never,
});

const FUTURE = 4_102_444_800_000;

function pooledOAuthEntry(): PooledCredential {
	return {
		type: "oauth",
		access: "default-access",
		refresh: "r-default",
		expires: FUTURE,
		accounts: [
			{ name: "default", access: "default-access", refresh: "r-default", expires: FUTURE, source: "login" },
			{ name: "alt", access: "alt-access", refresh: "r-alt", expires: 1, source: "login" },
		],
	};
}

function oauthProvider(refreshed: (credential: OAuthCredential) => OAuthCredential): Provider {
	return createProvider({
		id: "slotoauth",
		name: "Slot OAuth",
		baseUrl: "https://slotoauth.example",
		auth: {
			apiKey: envApiKeyAuth("Slot OAuth API key", ["SLOTOAUTH_API_KEY"]),
			oauth: {
				name: "Slot OAuth",
				login: async () => ({ type: "oauth", access: "a", refresh: "r", expires: FUTURE }),
				refresh: async (credential: OAuthCredential) => refreshed(credential),
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
		models: [],
		api: "openai-responses" as never,
	});
}

describe("slot-scoped auth resolution", () => {
	test("slotName resolves the named api_key slot instead of the flat projection", async () => {
		const store = new InMemoryCredentialStore();
		await store.modify("slottest", async () => pooledApiKeyEntry());

		const resolved = await resolveProviderAuth(apiKeyProvider, store, authContext, { slotName: "work" });

		expect(resolved?.auth.apiKey).toBe("work-key");
	});

	test("an unknown slotName resolves to undefined instead of another account", async () => {
		const store = new InMemoryCredentialStore();
		await store.modify("slottest", async () => pooledApiKeyEntry());

		const resolved = await resolveProviderAuth(apiKeyProvider, store, authContext, { slotName: "missing" });

		expect(resolved).toBeUndefined();
	});

	test("slotName refreshes only the named oauth slot and leaves siblings byte-identical", async () => {
		const store = new InMemoryCredentialStore();
		await store.modify("slotoauth", async () => pooledOAuthEntry());
		const refreshedFrom: string[] = [];
		const provider = oauthProvider((credential) => {
			refreshedFrom.push(credential.refresh);
			return {
				type: "oauth",
				access: `refreshed-${credential.refresh}`,
				refresh: `${credential.refresh}-next`,
				expires: FUTURE,
			};
		});

		const resolved = await resolveProviderAuth(provider, store, authContext, { slotName: "alt" });

		expect(refreshedFrom).toEqual(["r-alt"]);
		expect(resolved?.auth.apiKey).toBe("refreshed-r-alt");
		const stored = (await store.read("slotoauth")) as PooledCredential;
		expect(listSlots(stored).find((slot) => slot.name === "alt")).toMatchObject({
			access: "refreshed-r-alt",
			refresh: "r-alt-next",
			expires: FUTURE,
		});
		expect(listSlots(stored).find((slot) => slot.name === "default")).toMatchObject({
			access: "default-access",
			refresh: "r-default",
			expires: FUTURE,
		});
		expect(stored).toMatchObject({ access: "default-access", refresh: "r-default", expires: FUTURE });
	});

	test("refreshing the flat-mirrored slot by name also rotates the downgrade projection", async () => {
		const store = new InMemoryCredentialStore();
		await store.modify("slotoauth", async () => {
			const entry = pooledOAuthEntry();
			const accounts = entry.accounts?.map((slot) => (slot.name === "default" ? { ...slot, expires: 1 } : slot));
			return { ...entry, expires: 1, accounts };
		});
		const provider = oauthProvider((credential) => ({
			type: "oauth",
			access: `refreshed-${credential.refresh}`,
			refresh: `${credential.refresh}-next`,
			expires: FUTURE,
		}));

		const resolved = await resolveProviderAuth(provider, store, authContext, { slotName: "default" });

		expect(resolved?.auth.apiKey).toBe("refreshed-r-default");
		const stored = (await store.read("slotoauth")) as PooledCredential;
		expect(stored).toMatchObject({ access: "refreshed-r-default", refresh: "r-default-next", expires: FUTURE });
		expect(listSlots(stored).find((slot) => slot.name === "alt")).toMatchObject({
			access: "alt-access",
			refresh: "r-alt",
			expires: 1,
		});
	});
});
