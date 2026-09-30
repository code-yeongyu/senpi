import { afterEach, describe, expect, test, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { envApiKeyAuth } from "../src/auth/helpers.ts";
import { chatgptSubscriptionOAuth } from "../src/auth/oauth/chatgpt-subscription.ts";
import { appendLoginSlot, listSlots, type PooledCredential } from "../src/auth/pool/slots.ts";
import { resolveProviderAuth } from "../src/auth/resolve.ts";
import type { AccountLoginReceipt, AuthInteraction, OAuthCredential } from "../src/auth/types.ts";
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

describe("ChatGPT refresh workspace boundary", () => {
	afterEach(() => vi.unstubAllGlobals());

	function accessToken(workspaceId: string | undefined): string {
		const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
		const auth =
			workspaceId === undefined ? {} : { "https://api.openai.com/auth": { chatgpt_account_id: workspaceId } };
		const payload = Buffer.from(JSON.stringify(auth)).toString("base64url");
		return `${header}.${payload}.signature`;
	}

	function provider(): Provider {
		return createProvider({
			id: "chatgpt-subscription",
			name: "ChatGPT Subscription",
			baseUrl: "https://chatgpt.com/backend-api/codex",
			auth: { apiKey: envApiKeyAuth("key", []), oauth: chatgptSubscriptionOAuth },
			models: [],
			api: "openai-responses" as never,
		});
	}

	test("concurrent matching logins report the reused slot and preserve siblings", async () => {
		const defaultAccess = accessToken("workspace-default");
		const workAccess = accessToken("workspace-work");
		const siblingAccess = accessToken("workspace-sibling");
		const workIdentity = { userId: "user-work", workspaceId: "workspace-work", verifiedEmail: "shared@example.test" };
		const store = new InMemoryCredentialStore();
		await store.modify("chatgpt-subscription", async () => ({
			type: "oauth",
			access: defaultAccess,
			refresh: "default-refresh",
			expires: 4_102_444_800_000,
			pinned: "work",
			accounts: [
				{ name: "default", access: defaultAccess, refresh: "default-refresh", expires: 4_102_444_800_000 },
				{
					name: "work",
					displayName: "Research",
					access: workAccess,
					refresh: "old-work-refresh",
					expires: 4_102_444_800_000,
					verifiedIdentity: workIdentity,
				},
				{
					name: "sibling",
					access: siblingAccess,
					refresh: "sibling-refresh",
					expires: 4_102_444_800_000,
					verifiedIdentity: {
						userId: "user-sibling",
						workspaceId: "workspace-sibling",
						verifiedEmail: "shared@example.test",
					},
				},
			],
		}));
		const newAccess = [accessToken("workspace-work"), accessToken("workspace-work")];
		const newRefresh = ["new-work-refresh-1", "new-work-refresh-2"];
		let nextLogin = 0;
		vi.spyOn(chatgptSubscriptionOAuth, "login").mockImplementation(async () => {
			const index = nextLogin++;
			return {
				type: "oauth",
				access: newAccess[index],
				refresh: newRefresh[index],
				expires: 4_102_444_800_000,
				verifiedIdentity: workIdentity,
			};
		});
		const models = createModels({ credentials: store });
		models.setProvider(provider());
		const receipts: AccountLoginReceipt[] = [];
		const interaction: AuthInteraction = {
			signal: new AbortController().signal,
			prompt: async () => "",
			notify: () => {},
			onAccountCommitted: (receipt) => receipts.push(receipt),
		};

		try {
			await Promise.all([
				models.login("chatgpt-subscription", "oauth", interaction),
				models.login("chatgpt-subscription", "oauth", interaction),
			]);
		} finally {
			vi.restoreAllMocks();
		}
		const saved = await store.read("chatgpt-subscription");
		const slots = listSlots(saved);
		expect(slots.map((slot) => slot.name)).toEqual(["default", "work", "sibling"]);
		expect(slots[0].access).toBe(defaultAccess);
		expect(slots[1]).toMatchObject({ displayName: "Research", verifiedIdentity: workIdentity });
		expect(newRefresh).toContain(slots[1].refresh);
		expect(slots[2].access).toBe(siblingAccess);
		expect(saved).toHaveProperty("pinned", "work");
		expect(receipts).toEqual([
			{ providerId: "chatgpt-subscription", name: "work", origin: "provider" },
			{ providerId: "chatgpt-subscription", name: "work", origin: "provider" },
		]);
	});

	test("a re-login and refresh serialized together retain both slots and the pin", async () => {
		const oldDefault = accessToken("workspace-default");
		const nextDefault = accessToken("workspace-default");
		const nextWork = accessToken("workspace-work");
		const workIdentity = { userId: "user-work", workspaceId: "workspace-work" };
		const store = new InMemoryCredentialStore();
		await store.modify("chatgpt-subscription", async () => ({
			type: "oauth",
			access: oldDefault,
			refresh: "default-refresh",
			expires: 1,
			pinned: "work",
			accounts: [
				{ name: "default", access: oldDefault, refresh: "default-refresh", expires: 1 },
				{
					name: "work",
					displayName: "Research",
					access: accessToken("workspace-work"),
					refresh: "old-work-refresh",
					expires: 4_102_444_800_000,
					verifiedIdentity: workIdentity,
				},
				{
					name: "sibling",
					access: accessToken("workspace-sibling"),
					refresh: "sibling-refresh",
					expires: 4_102_444_800_000,
				},
			],
		}));
		const entered = { resolve: () => {} };
		const started = new Promise<void>((resolve) => {
			entered.resolve = resolve;
		});
		const release = { resolve: () => {} };
		const held = new Promise<void>((resolve) => {
			release.resolve = resolve;
		});
		const loginWrite = store.modify("chatgpt-subscription", async (current) => {
			entered.resolve();
			await held;
			return appendLoginSlot(current, {
				type: "oauth",
				access: nextWork,
				refresh: "new-work-refresh",
				expires: 4_102_444_800_000,
				verifiedIdentity: workIdentity,
			});
		});
		await started;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							access_token: nextDefault,
							refresh_token: "new-default-refresh",
							expires_in: 3600,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
			),
		);
		const refresh = resolveProviderAuth(provider(), store, authContext, { slotName: "default" });
		release.resolve();
		const [, resolved] = await Promise.all([loginWrite, refresh]);

		expect(resolved?.auth.apiKey).toBe(nextDefault);
		const saved = await store.read("chatgpt-subscription");
		const slots = listSlots(saved);
		expect(slots.map((slot) => slot.name)).toEqual(["default", "work", "sibling"]);
		expect(slots[0]).toMatchObject({ access: nextDefault, refresh: "new-default-refresh" });
		expect(slots[1]).toMatchObject({
			displayName: "Research",
			access: nextWork,
			refresh: "new-work-refresh",
			verifiedIdentity: workIdentity,
		});
		expect(slots[2].refresh).toBe("sibling-refresh");
		expect(saved).toHaveProperty("pinned", "work");
	});

	test.each([
		["legacy flat", false, false],
		["legacy pooled", true, false],
		["verified pooled", true, true],
	])("same-workspace refresh preserves %s metadata and siblings", async (_case, pooled, verified) => {
		const oldAccess = accessToken("workspace-1");
		const nextAccess = accessToken("workspace-1");
		const identity = verified
			? { verifiedIdentity: { userId: "user-1", workspaceId: "workspace-1", verifiedEmail: "person@example.test" } }
			: {};
		const entry: PooledCredential = pooled
			? {
					type: "oauth",
					access: oldAccess,
					refresh: "old-refresh",
					expires: 1,
					pinned: "default",
					accounts: [
						{
							name: "default",
							displayName: "Manual",
							source: "login",
							access: oldAccess,
							refresh: "old-refresh",
							expires: 1,
							...identity,
						},
						{
							name: "sibling",
							source: "login",
							access: "sibling-access",
							refresh: "sibling-refresh",
							expires: 4_102_444_800_000,
						},
					],
				}
			: { type: "oauth", access: oldAccess, refresh: "old-refresh", expires: 1, ...identity };
		const store = new InMemoryCredentialStore();
		await store.modify("chatgpt-subscription", async () => entry);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({ access_token: nextAccess, refresh_token: "next-refresh", expires_in: 3600 }),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
			),
		);

		await expect(resolveProviderAuth(provider(), store, authContext)).resolves.toMatchObject({
			auth: { apiKey: nextAccess },
		});
		const stored = (await store.read("chatgpt-subscription")) as PooledCredential;
		if (verified) expect(listSlots(stored)[0]).toMatchObject(identity);
		if (pooled) {
			expect(stored.pinned).toBe("default");
			expect(listSlots(stored)[0]?.displayName).toBe("Manual");
			expect(listSlots(stored)[1]).toMatchObject({ access: "sibling-access", refresh: "sibling-refresh" });
		}
	});

	test("rejects refresh when verified metadata disagrees with otherwise stable routing", async () => {
		const oldAccess = accessToken("workspace-1");
		const entry: PooledCredential = {
			type: "oauth",
			access: oldAccess,
			refresh: "old-refresh",
			expires: 1,
			verifiedIdentity: { userId: "user-1", workspaceId: "workspace-other" },
		};
		const store = new InMemoryCredentialStore();
		await store.modify("chatgpt-subscription", async () => entry);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							access_token: accessToken("workspace-1"),
							refresh_token: "next-refresh",
							expires_in: 3600,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
			),
		);

		await expect(resolveProviderAuth(provider(), store, authContext)).rejects.toThrow(/workspace.*re-login/i);
		expect(await store.read("chatgpt-subscription")).toEqual(entry);
	});

	test.each([
		["absent", undefined],
		["stale", { userId: "flat-user", workspaceId: "flat-workspace" }],
	])("checks the exact selected slot when flat verified identity is %s", async (_case, flatIdentity) => {
		const selectedAccess = accessToken("workspace-selected");
		const entry: PooledCredential = {
			type: "oauth",
			access: accessToken("workspace-flat"),
			refresh: "flat-refresh",
			expires: 4_102_444_800_000,
			...(flatIdentity === undefined ? {} : { verifiedIdentity: flatIdentity }),
			pinned: "selected",
			accounts: [
				{
					name: "default",
					source: "login",
					access: accessToken("workspace-flat"),
					refresh: "flat-refresh",
					expires: 4_102_444_800_000,
				},
				{
					name: "selected",
					displayName: "Selected",
					source: "login",
					access: selectedAccess,
					refresh: "selected-refresh",
					expires: 1,
					verifiedIdentity: { userId: "selected-user", workspaceId: "workspace-stored" },
				},
			],
		};
		const before = structuredClone(entry);
		const store = new InMemoryCredentialStore();
		await store.modify("chatgpt-subscription", async () => entry);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							access_token: selectedAccess,
							refresh_token: "next-selected-refresh",
							expires_in: 3600,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
			),
		);

		await expect(resolveProviderAuth(provider(), store, authContext, { slotName: "selected" })).rejects.toThrow(
			/workspace.*re-login/i,
		);
		expect(await store.read("chatgpt-subscription")).toEqual(before);
	});

	test.each([
		["absent", undefined],
		["stale", { userId: "flat-user", workspaceId: "workspace-selected" }],
	])("checks the mirrored pooled slot on an unscoped refresh with %s flat identity", async (_case, flatIdentity) => {
		const oldAccess = accessToken("workspace-selected");
		const entry: PooledCredential = {
			type: "oauth",
			access: oldAccess,
			refresh: "old-refresh",
			expires: 1,
			...(flatIdentity === undefined ? {} : { verifiedIdentity: flatIdentity }),
			accounts: [
				{
					name: "default",
					access: oldAccess,
					refresh: "old-refresh",
					expires: 1,
					verifiedIdentity: { userId: "actual-user", workspaceId: "workspace-stored" },
				},
				{ name: "sibling", access: "sibling-access", refresh: "sibling-refresh", expires: 4_102_444_800_000 },
			],
		};
		const store = new InMemoryCredentialStore();
		await store.modify("chatgpt-subscription", async () => entry);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							access_token: oldAccess,
							refresh_token: "next-refresh",
							expires_in: 3600,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
			),
		);

		await expect(resolveProviderAuth(provider(), store, authContext)).rejects.toThrow(/workspace.*re-login/i);
		expect(await store.read("chatgpt-subscription")).toEqual(entry);
	});

	test.each([
		["legacy flat mismatch", false, "workspace-2"],
		["legacy flat missing", false, undefined],
		["legacy pooled mismatch", true, "workspace-2"],
		["legacy pooled missing", true, undefined],
		["verified pooled mismatch", true, "workspace-2"],
	])("rejects %s before credential mutation", async (_case, pooled, refreshedWorkspace) => {
		const oldAccess = accessToken("workspace-1");
		const identity = {
			verifiedIdentity: { userId: "user-1", workspaceId: "workspace-1", verifiedEmail: "person@example.test" },
		};
		const entry: PooledCredential = pooled
			? {
					type: "oauth",
					access: oldAccess,
					refresh: "old-refresh",
					expires: 1,
					pinned: "default",
					accounts: [
						{
							name: "default",
							displayName: "Manual",
							source: "login",
							access: oldAccess,
							refresh: "old-refresh",
							expires: 1,
							...identity,
						},
						{
							name: "sibling",
							source: "login",
							access: "sibling-access",
							refresh: "sibling-refresh",
							expires: 4_102_444_800_000,
						},
					],
				}
			: { type: "oauth", access: oldAccess, refresh: "old-refresh", expires: 1 };
		const before = structuredClone(entry);
		const store = new InMemoryCredentialStore();
		await store.modify("chatgpt-subscription", async () => entry);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							access_token: accessToken(refreshedWorkspace),
							refresh_token: "next-refresh",
							expires_in: 3600,
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
			),
		);

		await expect(resolveProviderAuth(provider(), store, authContext)).rejects.toThrow(/workspace.*re-login/i);
		expect(await store.read("chatgpt-subscription")).toEqual(before);
	});
});
