import { describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import type { Credential, OAuthAuth, OAuthCredential } from "../src/auth/types.ts";
import { createModels, createProvider } from "../src/models.ts";
import { ModelsError } from "../src/utils/models-error.ts";

// senpi#7406: a sign-out the user confirmed for one sign-in must not remove a newer one. `expectedLoginId`
// names the confirmed sign-in; the store compares it inside its own write exclusion.
const PROVIDER = "p1";
const signIn = (loginId: string): Credential => ({ type: "api_key", key: `key-${loginId}`, loginId });

async function stored(...credentials: Credential[]) {
	const store = new InMemoryCredentialStore();
	for (const credential of credentials) await store.modify(PROVIDER, async () => credential);
	return { store, models: createModels({ credentials: store }) };
}

async function staleRefusal(logout: Promise<unknown>) {
	const error = await logout.then(
		() => undefined,
		(cause: unknown) => cause,
	);
	expect(error).toBeInstanceOf(ModelsError);
	expect(error).toMatchObject({ code: "stale_login" });
}

describe("logout with expectedLoginId (senpi#7406)", () => {
	it("refuses when a newer sign-in replaced the confirmed one, and keeps the newer one", async () => {
		const { store, models } = await stored(signIn("a"), signIn("b"));
		await staleRefusal(models.logout(PROVIDER, { expectedLoginId: "a" }));
		expect(await store.read(PROVIDER)).toEqual(signIn("b"));
	});

	it("compares inside the store's write exclusion: a sign-in queued ahead of the logout wins", async () => {
		const { store, models } = await stored(signIn("a"));
		const replacing = Promise.withResolvers<void>();
		const replacementStarted = Promise.withResolvers<void>();
		const replacement = store.modify(PROVIDER, async () => {
			replacementStarted.resolve();
			await replacing.promise;
			return signIn("b");
		});
		await replacementStarted.promise;
		// The caller confirmed "a" and sends the sign-out while the replacement holds the store.
		const logout = models.logout(PROVIDER, { expectedLoginId: "a" });
		replacing.resolve();
		await replacement;
		await staleRefusal(logout);
		expect(await store.read(PROVIDER)).toEqual(signIn("b"));
	});

	it("signs out the confirmed sign-in while it is unchanged, and refuses a duplicate request", async () => {
		const { store, models } = await stored(signIn("a"));
		await models.logout(PROVIDER, { expectedLoginId: "a" });
		expect(await store.read(PROVIDER)).toBeUndefined();

		await staleRefusal(models.logout(PROVIDER, { expectedLoginId: "a" }));
		await store.modify(PROVIDER, async () => signIn("c"));
		await staleRefusal(models.logout(PROVIDER, { expectedLoginId: "a" }));
		expect(await store.read(PROVIDER)).toEqual(signIn("c"));
	});

	it.each([
		["an empty expected id", signIn("a"), ""],
		["a stored sign-in without a loginId", { type: "api_key", key: "legacy" } satisfies Credential, "a"],
	])("refuses %s and changes nothing", async (_name, credential, expectedLoginId) => {
		const { store, models } = await stored(credential);
		await staleRefusal(models.logout(PROVIDER, { expectedLoginId }));
		expect(await store.read(PROVIDER)).toEqual(credential);
	});

	it("refuses before clearing or revoking a remotely revocable sign-in that was replaced", async () => {
		const newer: OAuthCredential = {
			type: "oauth",
			access: "access-b",
			refresh: "refresh-b",
			expires: Number.MAX_SAFE_INTEGER,
			loginId: "b",
		};
		const revoke = vi.fn<NonNullable<OAuthAuth["revoke"]>>(async () => ({ status: "revoked" }));
		const { store, models } = await stored(newer);
		models.setProvider(
			createProvider({
				id: PROVIDER,
				auth: {
					oauth: {
						name: "Revocable",
						login: async () => newer,
						refresh: async (credential) => credential,
						toAuth: async (credential) => ({ apiKey: credential.access }),
						revoke,
					},
				},
				models: [],
				api: {
					stream: () => {
						throw new Error("Not used");
					},
					streamSimple: () => {
						throw new Error("Not used");
					},
				},
			}),
		);
		await staleRefusal(models.logout(PROVIDER, { expectedLoginId: "a" }));
		expect(revoke).not.toHaveBeenCalled();
		expect(await store.read(PROVIDER)).toEqual(newer);
	});
});
