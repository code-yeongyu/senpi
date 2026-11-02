// #1542: a catalog refresh (or setProvider) issued while a token refresh is in flight
// joins that refresh instead of aborting it through the per-provider controller.
import { describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import type { CredentialStore, OAuthCredential } from "../src/auth/types.ts";
import { createModels, type Provider } from "../src/models.ts";
import type { Model } from "../src/types.ts";

function deferred<T = void>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

const MODEL: Model<"openai-responses"> = {
	id: "model-a",
	name: "Model A",
	api: "openai-responses",
	provider: "joined",
	baseUrl: "https://joined.example",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

function dynamicOAuthProvider(
	refresh: (credential: OAuthCredential, signal: AbortSignal) => Promise<OAuthCredential>,
): Provider {
	const stream = () => {
		throw new Error("not used");
	};
	return {
		id: "joined",
		name: "Joined",
		auth: {
			oauth: {
				name: "Joined OAuth",
				login: async () => ({ type: "oauth", access: "a", refresh: "r", expires: 0 }),
				refresh,
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
		getModels: () => [MODEL],
		refreshModels: async () => {},
		stream,
		streamSimple: stream,
	};
}

async function seedExpired(store: InMemoryCredentialStore): Promise<void> {
	await store.modify("joined", async () => ({ type: "oauth", access: "old", refresh: "r-old", expires: 0 }));
}

describe("catalog refresh joins an in-flight token refresh (#1542)", () => {
	it("a second refresh for the same provider does not abort the token exchange", async () => {
		const store = new InMemoryCredentialStore();
		await seedExpired(store);
		const started = deferred();
		const gate = deferred();
		const signals: AbortSignal[] = [];
		const models = createModels({ credentials: store });
		models.setProvider(
			dynamicOAuthProvider(async (credential, signal) => {
				signals.push(signal);
				started.resolve();
				await gate.promise;
				return { ...credential, access: "fresh", refresh: "r-new", expires: Date.now() + 3_600_000 };
			}),
		);

		const first = models.refresh({ providers: ["joined"] });
		await started.promise;
		const second = models.refresh({ providers: ["joined"] });
		await Promise.resolve();
		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(false);
		gate.resolve();

		const [firstResult, secondResult] = await Promise.all([first, second]);
		expect(signals).toHaveLength(1);
		expect(secondResult.errors.size).toBe(0);
		expect(secondResult.aborted).toBe(false);
		expect(firstResult.aborted).toBe(false);
		expect(await store.read("joined")).toMatchObject({ access: "fresh", refresh: "r-new" });
	});

	it("re-registering the provider mid-refresh does not abort the token exchange", async () => {
		const store = new InMemoryCredentialStore();
		await seedExpired(store);
		const started = deferred();
		const gate = deferred();
		const written = deferred();
		const signals: AbortSignal[] = [];
		// The superseded catalog refresh stops waiting, so observe the write itself.
		const observed: CredentialStore = {
			read: (providerId, options) => store.read(providerId, options),
			list: (options) => store.list(options),
			modify: async (providerId, fn, options) => {
				try {
					return await store.modify(providerId, fn, options);
				} finally {
					written.resolve();
				}
			},
			delete: (providerId, options) => store.delete(providerId, options),
		};
		const models = createModels({ credentials: observed });
		const provider = dynamicOAuthProvider(async (credential, signal) => {
			signals.push(signal);
			started.resolve();
			await gate.promise;
			return { ...credential, access: "fresh", refresh: "r-new", expires: Date.now() + 3_600_000 };
		});
		models.setProvider(provider);

		const refreshing = models.refresh({ providers: ["joined"] });
		await started.promise;
		models.setProvider(provider);
		expect(signals[0]?.aborted).toBe(false);
		gate.resolve();

		await refreshing;
		await written.promise;
		expect(signals).toHaveLength(1);
		expect(await store.read("joined")).toMatchObject({ access: "fresh", refresh: "r-new" });
	});
});
