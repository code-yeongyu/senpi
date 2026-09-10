import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { envApiKeyAuth } from "../src/auth/helpers.ts";
import { listSlots, type PooledCredential } from "../src/auth/pool/slots.ts";
import { resolveProviderAuth } from "../src/auth/resolve.ts";
import type { OAuthCredential, ProviderAuth } from "../src/auth/types.ts";

const NOW = 1_800_000_000_000;
const FUTURE = NOW + 3_600_000;
const authContext = { env: async () => "ambient-key", fileExists: async () => false };
const provider = {
	id: "pinned-test",
	auth: {
		apiKey: envApiKeyAuth("Test key", ["TEST_KEY"]),
		oauth: {
			name: "Test OAuth",
			login: async () => {
				throw new Error("Login is not part of auth resolution");
			},
			refresh: async (credential: OAuthCredential) => ({
				...credential,
				access: `${credential.access}-renewed`,
				refresh: `${credential.refresh}-renewed`,
				expires: FUTURE,
			}),
			toAuth: async (credential: OAuthCredential) => ({ apiKey: credential.access }),
		},
	} satisfies ProviderAuth,
};

function pooledCredential(type: "oauth" | "api_key"): PooledCredential {
	if (type === "api_key") {
		return {
			type,
			key: "default-key",
			pinned: "login-6",
			accounts: [
				{ name: "default", key: "default-key" },
				{ name: "login-6", key: "selected-key" },
			],
		};
	}
	return {
		type,
		access: "default-key",
		refresh: "default-refresh",
		expires: FUTURE,
		pinned: "login-6",
		accounts: [
			{ name: "default", access: "default-key", refresh: "default-refresh", expires: FUTURE },
			{ name: "login-6", access: "selected-key", refresh: "selected-refresh", expires: FUTURE },
		],
	};
}

describe("stored pinned account auth resolution", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});
	afterEach(() => vi.useRealTimers());

	for (const type of ["oauth", "api_key"] as const) {
		describe(type, () => {
			it("uses the pin when the caller does not select a slot", async () => {
				// given
				const store = new InMemoryCredentialStore();
				const entry = pooledCredential(type);
				await store.modify(provider.id, async () => entry);
				// when
				const resolved = await resolveProviderAuth(provider, store, authContext);
				// then
				expect(resolved?.auth.apiKey).toBe("selected-key");
				expect(await store.read(provider.id)).toEqual(entry);
			});

			it("lets an explicit slot override the pin", async () => {
				// given
				const store = new InMemoryCredentialStore();
				await store.modify(provider.id, async () => pooledCredential(type));
				// when
				const resolved = await resolveProviderAuth(provider, store, authContext, { slotName: "default" });
				// then
				expect(resolved?.auth.apiKey).toBe("default-key");
			});

			it("lets an explicit request key override the pin and slot", async () => {
				// given
				const store = new InMemoryCredentialStore();
				await store.modify(provider.id, async () => pooledCredential(type));
				// when
				const resolved = await resolveProviderAuth(provider, store, authContext, {
					apiKey: "request-key",
					slotName: "default",
				});
				// then
				expect(resolved?.auth.apiKey).toBe("request-key");
			});

			it("keeps the flat default when no pin is saved", async () => {
				// given
				const store = new InMemoryCredentialStore();
				const { pinned: _pinned, ...entry } = pooledCredential(type);
				await store.modify(provider.id, async () => entry);
				// when
				const resolved = await resolveProviderAuth(provider, store, authContext);
				// then
				expect(resolved?.auth.apiKey).toBe("default-key");
			});

			it("does not fall back to default or ambient auth for a missing pin", async () => {
				// given
				const store = new InMemoryCredentialStore();
				await store.modify(provider.id, async () => ({ ...pooledCredential(type), pinned: "missing" }));
				// when
				const resolved = await resolveProviderAuth(provider, store, authContext);
				// then
				expect(resolved).toBeUndefined();
			});
		});
	}

	it("refreshes the pinned OAuth slot without changing the default account", async () => {
		// given
		const store = new InMemoryCredentialStore();
		const entry = pooledCredential("oauth");
		await store.modify(provider.id, async () => ({
			...entry,
			accounts: entry.accounts?.map((slot) => (slot.name === "login-6" ? { ...slot, expires: NOW - 1 } : slot)),
		}));
		// when
		const resolved = await resolveProviderAuth(provider, store, authContext);
		// then
		expect(resolved?.auth.apiKey).toBe("selected-key-renewed");
		const stored: PooledCredential | undefined = await store.read(provider.id);
		expect(stored).toMatchObject({
			access: "default-key",
			refresh: "default-refresh",
			expires: FUTURE,
			pinned: "login-6",
		});
		expect(listSlots(stored).find((slot) => slot.name === "default")).toEqual(entry.accounts?.[0]);
		expect(listSlots(stored).find((slot) => slot.name === "login-6")).toMatchObject({
			access: "selected-key-renewed",
			refresh: "selected-refresh-renewed",
			expires: FUTURE,
		});
	});
});
