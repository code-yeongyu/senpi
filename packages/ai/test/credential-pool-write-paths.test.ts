import { Buffer } from "node:buffer";
import { describe, expect, test, vi } from "vitest";
import { InMemoryCredentialStore, revokeStoredOAuth } from "../src/auth/credential-store.ts";
import { envApiKeyAuth } from "../src/auth/helpers.ts";
import { stampLogin } from "../src/auth/pool/login-id.ts";
import { appendLoginSlot, listSlots, type PooledCredential, removeSlot, upsertSlot } from "../src/auth/pool/slots.ts";
import { resolveRefreshCredential } from "../src/auth/refresh-credential.ts";
import { resolveProviderAuth } from "../src/auth/resolve.ts";
import type { AuthInteraction, AuthOperationOptions, OAuthAuth, OAuthCredential } from "../src/auth/types.ts";
import { createModels, createProvider, type Provider } from "../src/models.ts";
import { extractChatGptSubscriptionIdentity } from "../src/utils/chatgpt-subscription-auth.ts";

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

describe("OAuth refresh reconciles only identified accounts (senpi#3407)", () => {
	const token = (member: string, version: string): string => {
		const payload = Buffer.from(
			JSON.stringify({
				"https://api.openai.com/auth": { chatgpt_account_id: "workspace", chatgpt_account_user_id: member },
				jti: version,
			}),
		).toString("base64url");
		return `e30.${payload}.signature`;
	};
	const identity: NonNullable<OAuthAuth["accountIdentity"]> = ({ access }) =>
		extractChatGptSubscriptionIdentity(access);
	const accountA = (version: string): OAuthCredential => ({
		type: "oauth",
		access: token("member-a", version),
		refresh: `refresh-a-${version}`,
		expires: version === "fresh" ? 4_102_444_800_000 : 1,
	});
	const accountB = (version: string): OAuthCredential => ({
		type: "oauth",
		access: token("member-b", version),
		refresh: `refresh-b-${version}`,
		expires: version === "fresh" ? 4_102_444_800_000 : 1,
	});
	const provider = (refresh: OAuthAuth["refresh"], accountIdentity?: OAuthAuth["accountIdentity"]) => ({
		id: "pooloauth",
		auth: {
			oauth: {
				name: "Pool OAuth",
				...(accountIdentity ? { accountIdentity } : {}),
				login: async () => accountA("fresh"),
				refresh,
				toAuth: async (credential: OAuthCredential) => ({ apiKey: credential.access }),
			},
		},
	});

	test("refreshes the uniquely identified slot instead of a different primary account", async () => {
		const store = new InMemoryCredentialStore();
		const flat = accountA("flat");
		const primary = { ...accountB("slot"), name: "default" };
		const matching = { ...accountA("slot"), name: "work" };
		await store.modify("pooloauth", async () => ({ ...flat, accounts: [primary, matching], pinned: "default" }));

		const result = await resolveProviderAuth(
			provider(async () => accountA("fresh"), identity),
			store,
			authContext,
		);

		expect(result?.auth.apiKey).toBe(accountA("fresh").access);
		const stored = await store.read("pooloauth");
		expect(listSlots(stored)).toEqual([
			primary,
			{ ...matching, ...accountA("fresh"), refreshContinuity: expect.any(String) },
		]);
		expect(stored?.type === "oauth" && stored.refresh).toBe(accountA("fresh").refresh);
	});

	test("refuses an unidentifiable flat refresh before exchanging or changing credentials", async () => {
		const store = new InMemoryCredentialStore();
		const original = { ...accountA("flat"), accounts: [{ ...accountB("slot"), name: "default" }] };
		await store.modify("pooloauth", async () => original);
		let exchanges = 0;

		const result = resolveProviderAuth(
			provider(async () => {
				exchanges++;
				return accountA("fresh");
			}),
			store,
			authContext,
		);

		await expect(result).rejects.toMatchObject({ code: "auth" });
		expect(exchanges).toBe(0);
		expect(await store.read("pooloauth")).toEqual(original);
	});

	test("refuses a flat refresh when the provider identity matches multiple slots", async () => {
		const store = new InMemoryCredentialStore();
		const original = {
			...accountA("flat"),
			accounts: [
				{ ...accountA("first"), name: "default" },
				{ ...accountA("second"), name: "work" },
			],
		};
		await store.modify("pooloauth", async () => original);
		let exchanges = 0;

		const result = resolveProviderAuth(
			provider(async () => {
				exchanges++;
				return accountA("fresh");
			}, identity),
			store,
			authContext,
		);

		await expect(result).rejects.toMatchObject({ code: "auth" });
		expect(exchanges).toBe(0);
		expect(await store.read("pooloauth")).toEqual(original);
	});

	test("refuses a flat refresh when its access and refresh tokens point to different slots", async () => {
		const store = new InMemoryCredentialStore();
		const flat = accountA("flat");
		const original = {
			...flat,
			accounts: [
				{ ...accountA("slot"), access: flat.access, name: "default" },
				{ ...accountB("slot"), refresh: flat.refresh, name: "work" },
			],
		};
		await store.modify("pooloauth", async () => original);
		let exchanges = 0;

		const result = resolveProviderAuth(
			provider(async () => {
				exchanges++;
				return accountA("fresh");
			}, identity),
			store,
			authContext,
		);

		await expect(result).rejects.toMatchObject({ code: "auth" });
		expect(exchanges).toBe(0);
		expect(await store.read("pooloauth")).toEqual(original);
	});

	test("uses the SIWC issuer, subject and client ID to distinguish registrations", async () => {
		const store = new InMemoryCredentialStore();
		const registration = { route: "siwc" as const, issuer: "issuer", subject: "member", clientId: "client-a" };
		const flat = { ...accountA("flat"), ...registration };
		const primary = { ...accountA("other"), ...registration, clientId: "client-b", name: "default" };
		const matching = { ...accountA("slot"), ...registration, name: "work" };
		const refreshed = { ...accountA("fresh"), ...registration };
		await store.modify("pooloauth", async () => ({ ...flat, accounts: [primary, matching] }));

		await resolveProviderAuth(
			provider(async () => refreshed, identity),
			store,
			authContext,
		);

		expect(listSlots(await store.read("pooloauth"))).toEqual([
			primary,
			{ ...matching, ...refreshed, refreshContinuity: expect.any(String) },
		]);
	});

	test("a named refresh does not replace the flat credential of a different account", async () => {
		const store = new InMemoryCredentialStore();
		const flat = accountA("flat");
		const primary = { ...accountB("slot"), name: "default" };
		await store.modify("pooloauth", async () => ({ ...flat, accounts: [primary] }));

		await resolveProviderAuth(
			provider(async () => accountB("fresh"), identity),
			store,
			authContext,
			{
				slotName: "default",
			},
		);

		const stored = await store.read("pooloauth");
		expect(stored?.type === "oauth" && stored.access).toBe(flat.access);
		expect(listSlots(stored)).toEqual([{ ...primary, ...accountB("fresh"), refreshContinuity: expect.any(String) }]);
	});

	test("a named refresh preserves a concurrent flat re-login even when its access token is unchanged", async () => {
		const store = new InMemoryCredentialStore();
		const flat = accountA("flat");
		const matching = { ...flat, name: "default" };
		await store.modify("pooloauth", async () => ({ ...flat, accounts: [matching] }));
		const auth = provider(async () => {
			await store.modify("pooloauth", async (current) =>
				current?.type === "oauth"
					? { ...current, refresh: "relogin-refresh", expires: 4_102_444_800_000 }
					: undefined,
			);
			return accountA("fresh");
		}, identity);

		await resolveProviderAuth(auth, store, authContext, { slotName: "default" });

		const stored = await store.read("pooloauth");
		expect(stored?.type === "oauth" && stored.refresh).toBe("relogin-refresh");
		expect(listSlots(stored)).toEqual([{ ...matching, ...accountA("fresh"), refreshContinuity: expect.any(String) }]);
	});

	test("preserves an independent flat credential when a named slot is replaced", async () => {
		const store = new InMemoryCredentialStore();
		const flat = accountA("flat");
		await store.modify("pooloauth", async () => ({ ...flat, accounts: [{ ...flat, name: "default" }] }));
		const replacement = { ...accountB("fresh"), name: "default" };
		const auth = provider(async () => {
			await store.modify("pooloauth", async (current) => upsertSlot(current, replacement));
			return accountA("fresh");
		}, identity);

		const result = resolveProviderAuth(auth, store, authContext);

		await expect(result).rejects.toMatchObject({ code: "auth" });
		const stored = await store.read("pooloauth");
		expect(listSlots(stored)).toEqual([replacement]);
		expect(stored?.type === "oauth" && stored.refresh).toBe(accountA("fresh").refresh);
		expect((await resolveProviderAuth(auth, store, authContext))?.auth.apiKey).toBe(accountA("fresh").access);
		expect((await resolveProviderAuth(auth, store, authContext, { slotName: "default" }))?.auth.apiKey).toBe(
			replacement.access,
		);
	});

	test("keeps the newer login when the same account signs in during refresh", async () => {
		const store = new InMemoryCredentialStore();
		const flat = accountA("flat");
		await store.modify("pooloauth", async () => ({ ...flat, accounts: [{ ...flat, name: "default" }] }));
		const replacement = { ...accountA("relogin"), expires: 4_102_444_800_000 };
		const auth = provider(async () => {
			await store.modify("pooloauth", async (current) =>
				appendLoginSlot(current, replacement, undefined, { accountIdentity: identity, reauthorizeSlot: "default" }),
			);
			return accountA("fresh");
		}, identity);

		const result = await resolveProviderAuth(auth, store, authContext);
		expect(result?.auth.apiKey).toBe(replacement.access);
		const stored = await store.read("pooloauth");
		expect(stored?.type === "oauth" && stored.refresh).toBe(replacement.refresh);
		expect(listSlots(stored)).toMatchObject([
			{ name: "default", access: replacement.access, refresh: replacement.refresh, expires: replacement.expires },
		]);
		expect((await resolveProviderAuth(auth, store, authContext))?.auth.apiKey).toBe(replacement.access);
	});

	test("does not adopt a different account replacing the flat credential and same slot without identity", async () => {
		const store = new InMemoryCredentialStore();
		const flat = { ...accountA("flat"), loginId: "same-login-id" };
		await store.modify("pooloauth", async () => ({ ...flat, accounts: [{ ...flat, name: "default" }] }));
		const replacement = { ...accountB("fresh"), loginId: flat.loginId };
		const auth = provider(async () => {
			await store.modify("pooloauth", async () => ({
				...replacement,
				accounts: [{ ...replacement, name: "default" }],
			}));
			return accountA("fresh");
		});

		await expect(resolveProviderAuth(auth, store, authContext)).rejects.toMatchObject({ code: "auth" });
		expect((await resolveProviderAuth(auth, store, authContext))?.auth.apiKey).toBe(replacement.access);
	});

	test("does not treat copied refresh metadata as proof for replacement tokens", async () => {
		const store = new InMemoryCredentialStore();
		const flat = accountA("flat");
		await store.modify("pooloauth", async () => ({ ...flat, accounts: [{ ...flat, name: "default" }] }));
		await resolveProviderAuth(
			provider(async () => accountA("fresh")),
			store,
			authContext,
		);
		await store.modify("pooloauth", async (current) =>
			current?.type === "oauth"
				? { ...current, expires: 1, accounts: listSlots(current).map((slot) => ({ ...slot, expires: 1 })) }
				: undefined,
		);
		const replacement = accountB("fresh");
		const auth = provider(async () => {
			await store.modify("pooloauth", async (current) =>
				current?.type === "oauth"
					? { ...upsertSlot(current, { ...replacement, name: "default" }), ...replacement }
					: undefined,
			);
			return accountA("fresh");
		});

		await expect(resolveProviderAuth(auth, store, authContext)).rejects.toMatchObject({ code: "auth" });
		expect((await resolveProviderAuth(auth, store, authContext))?.auth.apiKey).toBe(replacement.access);
	});

	test("persists a consumed token when continuity hashing fails", async () => {
		const store = new InMemoryCredentialStore();
		const flat = accountA("flat");
		await store.modify("pooloauth", async () => ({ ...flat, accounts: [{ ...flat, name: "default" }] }));
		const auth = provider(async () => accountA("fresh"));
		const digest = vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(new Error("digest unavailable"));
		try {
			await expect(resolveProviderAuth(auth, store, authContext)).rejects.toMatchObject({ code: "auth" });
		} finally {
			digest.mockRestore();
		}

		expect((await resolveProviderAuth(auth, store, authContext))?.auth.apiKey).toBe(accountA("fresh").access);
		expect(listSlots(await store.read("pooloauth"))).toMatchObject([{ ...accountA("fresh"), name: "default" }]);
	});

	test("requires a retry when a concurrent flat refresh cannot be identified", async () => {
		const store = new InMemoryCredentialStore();
		const flat = { ...accountA("flat"), loginId: "same-login-id" };
		await store.modify("pooloauth", async () => ({ ...flat, accounts: [{ ...flat, name: "default" }] }));
		const rotated = { ...accountA("other-refresh"), expires: 4_102_444_800_000, loginId: flat.loginId };
		const auth = provider(async () => {
			await store.modify("pooloauth", async () => ({
				...rotated,
				accounts: [{ ...rotated, name: "default" }],
			}));
			return accountA("fresh");
		});

		await expect(resolveProviderAuth(auth, store, authContext)).rejects.toMatchObject({ code: "auth" });
		expect((await resolveProviderAuth(auth, store, authContext))?.auth.apiKey).toBe(rotated.access);
	});

	test.each([
		{ account: "same", replacement: accountA("fresh") },
		{ account: "different", replacement: accountB("fresh") },
	])("requires a retry after $account-account reauthorization without provider identity", async ({ replacement }) => {
		const store = new InMemoryCredentialStore();
		const flat = { ...accountA("flat"), loginId: "original-login" };
		await store.modify("pooloauth", async () => ({ ...flat, accounts: [{ ...flat, name: "default" }] }));
		const auth = provider(async () => {
			await store.modify("pooloauth", async (current) =>
				stampLogin(appendLoginSlot(current, replacement, undefined, { reauthorizeSlot: "default" })),
			);
			return accountA("fresh");
		});

		await expect(resolveProviderAuth(auth, store, authContext)).rejects.toMatchObject({ code: "auth" });
		expect((await resolveProviderAuth(auth, store, authContext))?.auth.apiKey).toBe(replacement.access);
	});

	test("does not restore a slot removed during a flat refresh", async () => {
		const store = new InMemoryCredentialStore();
		const flat = accountA("flat");
		const survivor = { ...accountB("fresh"), name: "work" };
		await store.modify("pooloauth", async () => ({
			...flat,
			accounts: [{ ...flat, name: "default" }, survivor],
		}));
		const auth = provider(async () => {
			await store.modify("pooloauth", async (current) => removeSlot(current, "default"));
			return accountA("fresh");
		}, identity);

		await expect(resolveProviderAuth(auth, store, authContext)).rejects.toMatchObject({ code: "auth" });
		expect(listSlots(await store.read("pooloauth"))).toEqual([survivor]);
		expect((await resolveProviderAuth(auth, store, authContext))?.auth.apiKey).toBe(survivor.access);
	});

	test("does not switch accounts when the flat slot is removed before the refresh read", async () => {
		class RemovingStore extends InMemoryCredentialStore {
			reads = 0;
			override async read(providerId: string, options?: AuthOperationOptions) {
				if (++this.reads === 2) {
					await this.modify(providerId, async (current) => removeSlot(current, "default"));
				}
				return super.read(providerId, options);
			}
		}
		const store = new RemovingStore();
		const flat = accountA("flat");
		const survivor = { ...accountB("fresh"), name: "work" };
		await store.modify("pooloauth", async () => ({
			...flat,
			accounts: [{ ...flat, name: "default" }, survivor],
		}));
		const auth = provider(async () => accountA("fresh"));

		await expect(resolveProviderAuth(auth, store, authContext)).rejects.toMatchObject({ code: "auth" });
		expect((await resolveProviderAuth(auth, store, authContext))?.auth.apiKey).toBe(survivor.access);
	});

	test("does not switch the catalog refresh to a surviving account", async () => {
		const store = new InMemoryCredentialStore();
		const flat = accountA("flat");
		const survivor = { ...accountB("fresh"), name: "work" };
		const original = { ...flat, accounts: [{ ...flat, name: "default" }, survivor] };
		await store.modify("pooloauth", async () => original);
		const auth = provider(async () => {
			await store.modify("pooloauth", async (current) => removeSlot(current, "default"));
			return accountA("fresh");
		}, identity);

		await expect(
			resolveRefreshCredential(auth, store, authContext, original, AbortSignal.timeout(5_000)),
		).rejects.toMatchObject({ code: "auth" });
		expect((await resolveProviderAuth(auth, store, authContext))?.auth.apiKey).toBe(survivor.access);
	});

	test.each([
		{ discardedStatus: "revoked", expectedStatus: "revoked", expectedCode: "auth" },
		{
			discardedStatus: "remote_revocation_unconfirmed",
			expectedStatus: "remote_revocation_unconfirmed",
			expectedCode: "oauth",
		},
	] as const)(
		"reports $expectedStatus when discarded refresh revocation is $discardedStatus",
		async ({ discardedStatus, expectedStatus, expectedCode }) => {
			const store = new InMemoryCredentialStore();
			const flat = accountA("flat");
			const survivor = { ...accountB("fresh"), name: "work" };
			await store.modify("pooloauth", async () => ({
				...flat,
				accounts: [{ ...flat, name: "default" }, survivor],
			}));
			let exchangeStarted = () => {};
			let finishExchange = () => {};
			let revocationStarted = () => {};
			const started = new Promise<void>((resolve) => {
				exchangeStarted = resolve;
			});
			const finish = new Promise<void>((resolve) => {
				finishExchange = resolve;
			});
			const revoking = new Promise<void>((resolve) => {
				revocationStarted = resolve;
			});
			const base = provider(async () => {
				exchangeStarted();
				await finish;
				return accountA("fresh");
			}, identity);
			let revocations = 0;
			const oauth: OAuthAuth = {
				...base.auth.oauth,
				revoke: async () => {
					revocationStarted();
					revocations++;
					return { status: revocations === 1 ? "revoked" : discardedStatus };
				},
			};
			const auth = { ...base, auth: { oauth } };
			const resolving = resolveProviderAuth(auth, store, authContext);
			const rejected = expect(resolving).rejects.toMatchObject({ code: expectedCode });
			await started;
			const logout = revokeStoredOAuth(store, "pooloauth", oauth, { slotId: "default" });
			await revoking;
			finishExchange();

			await rejected;
			expect(await logout).toEqual({ status: expectedStatus });
			expect(revocations).toBe(2);
			expect((await resolveProviderAuth(auth, store, authContext))?.auth.apiKey).toBe(survivor.access);
		},
	);

	test("preserves a flat refresh when an unrelated slot is removed", async () => {
		const store = new InMemoryCredentialStore();
		const flat = accountA("flat");
		const matching = { ...accountA("slot"), name: "default" };
		const sibling = { ...accountB("fresh"), name: "work" };
		await store.modify("pooloauth", async () => ({ ...flat, accounts: [matching, sibling] }));
		const auth = provider(async () => {
			await store.modify("pooloauth", async (current) => removeSlot(current, "work"));
			return accountA("fresh");
		}, identity);

		expect((await resolveProviderAuth(auth, store, authContext))?.auth.apiKey).toBe(accountA("fresh").access);
		expect(listSlots(await store.read("pooloauth"))).toEqual([
			{ ...matching, ...accountA("fresh"), refreshContinuity: expect.any(String) },
		]);
		expect((await resolveProviderAuth(auth, store, authContext))?.auth.apiKey).toBe(accountA("fresh").access);
	});
});
