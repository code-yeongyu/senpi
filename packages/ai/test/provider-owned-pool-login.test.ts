import { describe, expect, test } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { listSlots, type PooledCredential } from "../src/auth/pool/slots.ts";
import type { AuthInteraction, OAuthCredential } from "../src/auth/types.ts";
import { createModels, createProvider } from "../src/models.ts";

const PROVIDER_ID = "provider-owned-pool";
const EXPIRES = 4_102_444_800_000;
type ProviderOwnedOAuthCredential = OAuthCredential & PooledCredential;

function pool(...names: string[]): ProviderOwnedOAuthCredential {
	return {
		type: "oauth",
		access: "managed",
		refresh: "managed",
		expires: EXPIRES,
		accounts: names.map((name) => ({
			name,
			access: `${name}-access`,
			refresh: `${name}-refresh`,
			expires: EXPIRES,
			source: "login",
		})),
	};
}

function interaction(): AuthInteraction {
	return {
		signal: AbortSignal.timeout(5_000),
		prompt: async () => "unused",
		notify: () => {},
	};
}

function provider(login: () => Promise<ProviderOwnedOAuthCredential>) {
	return createProvider({
		id: PROVIDER_ID,
		name: "Provider-owned Pool",
		baseUrl: "https://provider-owned-pool.example",
		auth: {
			oauth: {
				name: "Provider-owned Pool",
				login,
				refresh: async (credential: OAuthCredential) => credential,
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
		models: [],
		api: "openai-responses" as never,
	});
}

function deferred<T>() {
	let settle: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => {
		settle = resolve;
	});
	return {
		promise,
		resolve(value: T) {
			if (!settle) throw new Error("deferred resolver was not initialized");
			settle(value);
		},
	};
}

describe("provider-owned pool login persistence", () => {
	test("merges accounts added by overlapping login flows", async () => {
		const entered = deferred<void>();
		const first = deferred<ProviderOwnedOAuthCredential>();
		const second = deferred<ProviderOwnedOAuthCredential>();
		let callCount = 0;
		const store = new InMemoryCredentialStore();
		const models = createModels({ credentials: store });
		models.setProvider(
			provider(async () => {
				const call = ++callCount;
				if (call === 2) entered.resolve();
				return call === 1 ? first.promise : second.promise;
			}),
		);
		await store.modify(PROVIDER_ID, async () => pool("default"));

		const firstLogin = models.login(PROVIDER_ID, "oauth", interaction());
		const secondLogin = models.login(PROVIDER_ID, "oauth", interaction());
		await entered.promise;
		first.resolve(pool("default", "first"));
		second.resolve(pool("default", "second"));
		await Promise.all([firstLogin, secondLogin]);

		const stored = (await store.read(PROVIDER_ID)) as PooledCredential;
		expect(new Set(listSlots(stored).map((slot) => slot.name))).toEqual(new Set(["default", "first", "second"]));
	});

	test("preserves an explicitly empty provider-owned pool", async () => {
		const store = new InMemoryCredentialStore();
		await store.modify(PROVIDER_ID, async () => pool("default"));
		const models = createModels({ credentials: store });
		models.setProvider(provider(async () => pool()));

		await models.login(PROVIDER_ID, "oauth", interaction());

		const stored = (await store.read(PROVIDER_ID)) as PooledCredential;
		expect(stored.accounts).toEqual([]);
	});
});
