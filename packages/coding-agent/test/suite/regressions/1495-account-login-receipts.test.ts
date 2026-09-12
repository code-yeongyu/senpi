import {
	type AuthInteraction,
	createModels,
	createProvider,
	type OAuthAuth,
	type OAuthCredential,
} from "@earendil-works/pi-ai";
import { listSlots } from "@earendil-works/pi-ai/auth/pool/slots";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { renameCredentialAccount } from "../../../src/core/credential-accounts.ts";
import {
	type ClaudeSdkOauthCredential,
	SENTINEL_OAUTH_FIELDS,
} from "../../../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";
import { createOAuthConfig } from "../../../src/core/extensions/builtin/claude-sdk-oauth/oauth-login.ts";
import { composedProvider } from "../../support/claude-sdk-oauth-provider.ts";

const fresh = { type: "oauth" as const, access: "fake-access", refresh: "fake-refresh", expires: 4102444800000 };
const flow: OAuthAuth = {
	name: "Fake",
	login: async () => fresh,
	refresh: async (current) => current,
	toAuth: async (current) => ({ apiKey: current.access }),
};
function interaction(receipts: unknown[], answer = "second"): AuthInteraction {
	return { prompt: async () => answer, notify: () => {}, onAccountCommitted: (receipt) => receipts.push(receipt) };
}

// senpi#1495: receipts must describe the committed slot, not token matches or list order.
describe("committed account receipts", () => {
	it("identifies two OpenAI logins with identical tokens, preserves the first display name", async () => {
		const storage = AuthStorage.inMemory();
		const models = createModels({ credentials: storage });
		models.setProvider(
			createProvider({
				id: "openai-codex",
				name: "Fake Codex",
				baseUrl: "https://example.invalid",
				auth: { oauth: flow },
				models: [],
				api: {},
			}),
		);
		const receipts: unknown[] = [];
		await models.login("openai-codex", "oauth", interaction(receipts));
		await renameCredentialAccount(storage, "openai-codex", "default", "Personal");
		await models.login("openai-codex", "oauth", interaction(receipts));
		expect(receipts).toEqual([
			{ providerId: "openai-codex", name: "default", origin: "generated" },
			{ providerId: "openai-codex", name: "login-2", origin: "generated" },
		]);
		expect(listSlots(storage.get("openai-codex")).map(({ name, displayName }) => ({ name, displayName }))).toEqual([
			{ name: "default", displayName: "Personal" },
			{ name: "login-2", displayName: undefined },
		]);
	});

	it.each([false, true])(
		"identifies Claude first/import and second login through the real envelope adapter (import=%s)",
		async (importFirst) => {
			const storage = AuthStorage.inMemory();
			const models = createModels({ credentials: storage });
			const config = createOAuthConfig({
				readCurrent: async () => storage.get("claude-sdk-oauth") as ClaudeSdkOauthCredential | undefined,
				readAnthropicCredential: async () => (importFirst ? fresh : undefined),
				loginFlow: flow,
			});
			models.setProvider(composedProvider(async () => false, { oauth: config }));
			const receipts: unknown[] = [];
			await models.login("claude-sdk-oauth", "oauth", interaction(receipts, "yes"));
			const first = importFirst ? "imported-anthropic" : "default";
			await renameCredentialAccount(storage, "claude-sdk-oauth", first, "Personal");
			await models.login("claude-sdk-oauth", "oauth", interaction(receipts));
			// The Claude envelope adapter owns slot naming end to end (it prompts
			// for the second id itself), so both receipts are provider-origin.
			expect(receipts).toEqual([
				{ providerId: "claude-sdk-oauth", name: first, origin: "provider" },
				{ providerId: "claude-sdk-oauth", name: "second", origin: "provider" },
			]);
			const saved = storage.get("claude-sdk-oauth") as ClaudeSdkOauthCredential;
			expect(saved).toMatchObject(SENTINEL_OAUTH_FIELDS);
			expect(saved.accounts?.map(({ name, displayName }) => ({ name, displayName }))).toEqual([
				{ name: first, displayName: "Personal" },
				{ name: "second", displayName: undefined },
			]);
		},
	);

	it("emits no receipt before persistence or on failure", async () => {
		const storage = AuthStorage.inMemory();
		const receipts: unknown[] = [];
		const models = createModels({
			credentials: {
				read: storage.read.bind(storage),
				list: storage.list.bind(storage),
				delete: storage.delete.bind(storage),
				modify: async (_provider, update) => {
					await update(undefined);
					expect(receipts).toEqual([]);
					throw new Error("synthetic write failure");
				},
			},
		});
		models.setProvider(
			createProvider({
				id: "openai-codex",
				name: "Fake",
				baseUrl: "https://example.invalid",
				auth: { oauth: flow },
				models: [],
				api: {},
			}),
		);
		await expect(models.login("openai-codex", "oauth", interaction(receipts))).rejects.toThrow();
		expect(receipts).toEqual([]);
	});

	it("identifies a provider-owned slot even when it is not last, and declines ambiguous envelopes", async () => {
		const old = { name: "old", source: "login", ...fresh };
		const added = { name: "new", source: "login", ...fresh };
		const storage = AuthStorage.inMemory({ p: { ...fresh, accounts: [old] } });
		let result: OAuthCredential = { ...fresh, accounts: [added, old] };
		const models = createModels({ credentials: storage });
		models.setProvider(
			createProvider({
				id: "p",
				name: "Fake",
				baseUrl: "https://example.invalid",
				auth: { oauth: { ...flow, login: async () => result } },
				models: [],
				api: {},
			}),
		);
		const receipts: unknown[] = [];
		await models.login("p", "oauth", interaction(receipts));
		expect(receipts).toEqual([{ providerId: "p", name: "new", origin: "provider" }]);
		result = { ...fresh, accounts: [added, old, { ...added, name: "third" }, { ...added, name: "fourth" }] };
		await models.login("p", "oauth", interaction(receipts));
		expect(receipts).toHaveLength(1);
	});
});
