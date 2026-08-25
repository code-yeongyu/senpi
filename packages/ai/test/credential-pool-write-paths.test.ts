import { describe, expect, test } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { envApiKeyAuth } from "../src/auth/helpers.ts";
import { listSlots, type PooledCredential } from "../src/auth/pool/slots.ts";
import { resolveProviderAuth } from "../src/auth/resolve.ts";
import type { AuthInteraction, OAuthCredential } from "../src/auth/types.ts";
import { createModels, createProvider, type Provider } from "../src/models.ts";

function promptInteraction(key: string): AuthInteraction {
	return {
		signal: AbortSignal.timeout(5_000),
		prompt: async () => key,
		notify: () => {},
	};
}

function pooledApiKeyEntry(): PooledCredential {
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

const apiKeyProvider: Provider = createProvider({
	id: "pooltest",
	name: "Pool Test",
	baseUrl: "https://pooltest.example/v1",
	auth: { apiKey: envApiKeyAuth("Pool Test API key", ["POOLTEST_API_KEY"]) },
	models: [],
	api: "openai-responses" as never,
});

const authContext = { env: async () => undefined, fileExists: async () => false };

describe("Models slot-preserving login/logout/refresh", () => {
	test("login into a pooled provider rotates the default slot and keeps siblings", async () => {
		const store = new InMemoryCredentialStore();
		await store.modify("pooltest", async () => pooledApiKeyEntry());
		const models = createModels({ credentials: store });
		models.setProvider(apiKeyProvider);

		await models.login("pooltest", "api_key", promptInteraction("rotated-key"));

		const stored = (await store.read("pooltest")) as PooledCredential;
		expect(listSlots(stored).map((slot) => slot.name)).toEqual(["default", "work", "login-2"]);
		expect(listSlots(stored).find((slot) => slot.name === "work")).toMatchObject({ key: "work-key" });
		expect(listSlots(stored).find((slot) => slot.name === "default")).toMatchObject({ key: "primary-key" });
		expect(listSlots(stored).find((slot) => slot.name === "login-2")).toMatchObject({ key: "rotated-key" });
	});

	test("logout with a slotId removes only that slot", async () => {
		const store = new InMemoryCredentialStore();
		await store.modify("pooltest", async () => pooledApiKeyEntry());
		const models = createModels({ credentials: store });

		await models.logout("pooltest", { slotId: "work" } as never);

		const stored = (await store.read("pooltest")) as PooledCredential | undefined;
		expect(listSlots(stored).map((slot) => slot.name)).toEqual(["default"]);
	});

	test("logout with no slot removes the whole entry (documented behavior)", async () => {
		const store = new InMemoryCredentialStore();
		await store.modify("pooltest", async () => pooledApiKeyEntry());
		const models = createModels({ credentials: store });

		await models.logout("pooltest");

		expect(await store.read("pooltest")).toBeUndefined();
	});
});

describe("OAuth refresh keeps sibling slots", () => {
	function pooledOAuthEntry(): PooledCredential {
		return {
			type: "oauth",
			access: "expired-access",
			refresh: "r1",
			expires: 1,
			accounts: [
				{ name: "default", access: "expired-access", refresh: "r1", expires: 1, source: "login" },
				{ name: "work", access: "work-access", refresh: "r2", expires: 4_102_444_800_000, source: "login" },
			],
			pinned: "work",
		};
	}

	const oauthProvider: Provider = createProvider({
		id: "pooloauth",
		name: "Pool OAuth",
		baseUrl: "https://pooloauth.example",
		auth: {
			apiKey: envApiKeyAuth("Pool OAuth API key", ["POOLOAUTH_API_KEY"]),
			oauth: {
				name: "Pool OAuth",
				login: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 4_102_444_800_000 }),
				refresh: async (credential: OAuthCredential) => ({
					type: "oauth",
					access: `refreshed-${credential.refresh}`,
					refresh: `${credential.refresh}-next`,
					expires: 4_102_444_800_000,
				}),
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
		models: [],
		api: "openai-responses" as never,
	});

	test("resolveProviderAuth refreshes the matching slot and leaves siblings byte-identical", async () => {
		const store = new InMemoryCredentialStore();
		await store.modify("pooloauth", async () => pooledOAuthEntry());

		const resolved = await resolveProviderAuth(oauthProvider, store, authContext);

		expect(resolved?.auth.apiKey).toBe("refreshed-r1");
		const stored = (await store.read("pooloauth")) as PooledCredential;
		expect(listSlots(stored).find((slot) => slot.name === "work")).toMatchObject({
			access: "work-access",
			refresh: "r2",
			expires: 4_102_444_800_000,
		});
		expect(stored.pinned).toBe("work");
		expect(listSlots(stored).find((slot) => slot.name === "default")).toMatchObject({
			access: "refreshed-r1",
			refresh: "r1-next",
		});
	});
});
