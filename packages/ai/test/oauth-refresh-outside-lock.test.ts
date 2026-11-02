// #1542: the OAuth token exchange runs outside the credential store's write path and
// the rotated token is compare-and-swapped on the slot's refresh token.
import { describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import type { PooledCredential } from "../src/auth/pool/slots.ts";
import type { AuthOperationOptions, Credential, CredentialStore, OAuthCredential } from "../src/auth/types.ts";
import { createModels, createProvider, type Provider } from "../src/models.ts";

const FUTURE = 4_102_444_800_000;

function deferred<T = void>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

/** Records how deep inside `modify` the store is while a refresh exchange runs. */
class WritePathSpy implements CredentialStore {
	private readonly inner = new InMemoryCredentialStore();
	modifyDepth = 0;

	read(providerId: string, options?: AuthOperationOptions) {
		return this.inner.read(providerId, options);
	}
	list(options?: AuthOperationOptions) {
		return this.inner.list(options);
	}
	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	) {
		return this.inner.modify(
			providerId,
			async (current) => {
				this.modifyDepth++;
				try {
					return await fn(current);
				} finally {
					this.modifyDepth--;
				}
			},
			options,
		);
	}
	delete(providerId: string, options?: AuthOperationOptions) {
		return this.inner.delete(providerId, options);
	}
}

function oauthProvider(
	refresh: (credential: OAuthCredential, signal: AbortSignal) => Promise<OAuthCredential>,
): Provider {
	return createProvider({
		id: "lockfree",
		name: "Lock Free",
		baseUrl: "https://lockfree.example",
		auth: {
			oauth: {
				name: "Lock Free OAuth",
				login: async () => ({ type: "oauth", access: "a", refresh: "r", expires: FUTURE }),
				refresh,
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
		models: [],
		api: "openai-responses" as never,
	});
}

function pooled(): PooledCredential {
	return {
		type: "oauth",
		access: "a-access",
		refresh: "r-a",
		expires: 1,
		accounts: [
			{ name: "a", access: "a-access", refresh: "r-a", expires: 1, source: "login" },
			{ name: "b", access: "b-access", refresh: "r-b", expires: 1, source: "login" },
		],
	};
}

describe("OAuth refresh outside the credential lock (#1542)", () => {
	it("runs the token exchange outside the store's write path", async () => {
		const store = new WritePathSpy();
		await store.modify("lockfree", async () => pooled());
		const depthDuringExchange: number[] = [];
		const provider = oauthProvider(async (credential) => {
			depthDuringExchange.push(store.modifyDepth);
			return {
				type: "oauth",
				access: `new-${credential.refresh}`,
				refresh: `${credential.refresh}-next`,
				expires: FUTURE,
			};
		});
		const models = createModels({ credentials: store });
		models.setProvider(provider);

		const resolved = await models.getAuth("lockfree", { slotName: "a" });

		expect(resolved?.auth.apiKey).toBe("new-r-a");
		expect(depthDuringExchange).toEqual([0]);
		const stored = (await store.read("lockfree")) as PooledCredential;
		expect(stored.accounts?.find((slot) => slot.name === "a")).toMatchObject({
			refresh: "r-a-next",
			access: "new-r-a",
		});
		expect(stored.accounts?.find((slot) => slot.name === "b")).toMatchObject({ refresh: "r-b", access: "b-access" });
	});

	it("adopts a slot rotated by another writer during the exchange instead of overwriting it", async () => {
		const store = new InMemoryCredentialStore();
		await store.modify("lockfree", async () => pooled());
		const started = deferred();
		const gate = deferred();
		let exchanges = 0;
		const provider = oauthProvider(async (credential) => {
			exchanges++;
			started.resolve();
			await gate.promise;
			return { type: "oauth", access: "stale-winner", refresh: `${credential.refresh}-next`, expires: FUTURE };
		});
		const models = createModels({ credentials: store });
		models.setProvider(provider);

		const resolving = models.getAuth("lockfree", { slotName: "a" });
		await started.promise;
		// Another writer rotates slot "a" while our exchange is in flight; the store
		// serializes it ahead of our compare-and-swap.
		const other = store.modify("lockfree", async (current) => {
			const entry = current as PooledCredential;
			return {
				...entry,
				access: "other-access",
				refresh: "r-a-other",
				expires: FUTURE,
				accounts: entry.accounts?.map((slot) =>
					slot.name === "a" ? { ...slot, access: "other-access", refresh: "r-a-other", expires: FUTURE } : slot,
				),
			};
		});
		gate.resolve();
		await other;

		const resolved = await resolving;
		expect(exchanges).toBe(1);
		expect(resolved?.auth.apiKey).toBe("other-access");
		const stored = (await store.read("lockfree")) as PooledCredential;
		expect(stored.accounts?.find((slot) => slot.name === "a")).toMatchObject({
			access: "other-access",
			refresh: "r-a-other",
		});
		expect(stored.accounts?.find((slot) => slot.name === "b")).toMatchObject({ refresh: "r-b" });
	});

	it("joins concurrent requests for the same slot into one exchange", async () => {
		const store = new InMemoryCredentialStore();
		await store.modify("lockfree", async () => pooled());
		const gate = deferred();
		let exchanges = 0;
		const provider = oauthProvider(async (credential) => {
			exchanges++;
			await gate.promise;
			return { type: "oauth", access: `new-${exchanges}`, refresh: `${credential.refresh}-next`, expires: FUTURE };
		});
		const models = createModels({ credentials: store });
		models.setProvider(provider);

		const first = models.getAuth("lockfree", { slotName: "b" });
		const second = models.getAuth("lockfree", { slotName: "b" });
		await Promise.resolve();
		gate.resolve();

		const [a, b] = await Promise.all([first, second]);
		expect(exchanges).toBe(1);
		expect(a?.auth.apiKey).toBe("new-1");
		expect(b?.auth.apiKey).toBe("new-1");
	});
});
