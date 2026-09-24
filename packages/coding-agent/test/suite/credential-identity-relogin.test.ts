import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AccountLoginReceipt,
	type AuthInteraction,
	createModels,
	createProvider,
	type OAuthAuth,
	type OAuthCredential,
} from "@earendil-works/pi-ai";
import { listSlots } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import {
	getCredentialAccountDetails,
	getCredentialAccounts,
	renameCredentialAccount,
} from "../../src/core/credential-accounts.ts";
import { CredentialSlotRepository } from "../../src/core/credential-pool/state-store.ts";
import accountExtension from "../../src/core/extensions/builtin/account/index.ts";
import { createAccountCommandContext, registerCommand } from "./account-command-harness.ts";

const PROVIDER = "identity-oauth";
const alice = { id: "account-alice/org-1", email: "alice@example.test" };
const bob = { id: "account-bob/org-1", email: "bob@example.test" };

let dir: string;
let storage: AuthStorage;
let repository: CredentialSlotRepository;
let nextLogin: OAuthCredential;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "credential-identity-"));
	storage = AuthStorage.create(join(dir, "auth.json"));
	repository = new CredentialSlotRepository(join(dir, "credential-pool-state.json"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function loginAs(tag: string, identity: typeof alice): OAuthCredential {
	return { type: "oauth", access: `${tag}-access`, refresh: `${tag}-refresh`, expires: 4102444800000, identity };
}

function identityModels() {
	const flow: OAuthAuth = {
		name: "Identity OAuth",
		login: async () => nextLogin,
		refresh: async (current) => current,
		toAuth: async (current) => ({ apiKey: current.access }),
	};
	const models = createModels({ credentials: storage });
	models.setProvider(
		createProvider({
			id: PROVIDER,
			name: "Identity OAuth",
			baseUrl: "https://example.invalid",
			auth: { oauth: flow },
			models: [],
			api: {},
		}),
	);
	return models;
}

async function login(models: ReturnType<typeof identityModels>, credential: OAuthCredential) {
	nextLogin = credential;
	const receipts: AccountLoginReceipt[] = [];
	const interaction: AuthInteraction = {
		prompt: async () => "",
		notify: () => {},
		onAccountCommitted: (receipt) => receipts.push(receipt),
	};
	await models.login(PROVIDER, "oauth", interaction);
	return receipts;
}

describe("re-login with a reported account identity", () => {
	it("refreshes the account's existing slot, keeps its display name, and reports it as updated", async () => {
		const models = identityModels();
		await login(models, loginAs("alice-1", alice));
		await login(models, loginAs("bob-1", bob));
		await renameCredentialAccount(storage, PROVIDER, "default", "Personal");

		const receipts = await login(models, loginAs("alice-2", alice));

		expect(receipts).toEqual([{ providerId: PROVIDER, name: "default", origin: "updated" }]);
		expect(
			listSlots(storage.get(PROVIDER)).map(({ name, displayName, access }) => ({ name, displayName, access })),
		).toEqual([
			{ name: "default", displayName: "Personal", access: "alice-2-access" },
			{ name: "login-2", displayName: undefined, access: "bob-1-access" },
		]);
		// default was the flat projection, so the credential ordinary requests read moves with it
		expect(storage.get(PROVIDER)).toMatchObject({ access: "alice-2-access", identity: alice });
	});

	it("revives an account the pool blocked for an auth error, and /account list says which account needs a login", async () => {
		const models = identityModels();
		await login(models, loginAs("alice-1", alice));
		await login(models, loginAs("bob-1", bob));
		const revision = await repository.storedCredentialRevision(PROVIDER, "login-2", {
			access: "bob-1-access",
			refresh: "bob-1-refresh",
		});
		await repository.mutateSlotState(PROVIDER, "stored", "login-2", () => ({
			blockReason: "auth_error",
			credentialRevision: revision,
		}));

		const { ctx, notices } = createAccountCommandContext(storage, dir);
		const command = registerCommand("account", accountExtension);
		await command.handler(`${PROVIDER} list`, ctx);
		const before = notices.at(-1)?.message ?? "";
		expect(before).toContain("default | alice@example.test | login | available");
		expect(before).toContain("login-2 | bob@example.test | login | blocked (log in again)");

		await login(models, loginAs("bob-2", bob));

		const accounts = await getCredentialAccountDetails(storage, PROVIDER, {}, repository);
		expect(accounts.map(({ name, email, blocked }) => ({ name, email, blocked }))).toEqual([
			{ name: "default", email: "alice@example.test", blocked: false },
			{ name: "login-2", email: "bob@example.test", blocked: false },
		]);
		// the wire-facing summaries (app-server, RPC, auth check) keep their shape
		expect(Object.keys((await getCredentialAccounts(storage, PROVIDER, {}, repository))[1]).sort()).toEqual([
			"blocked",
			"name",
			"pinned",
			"source",
		]);
		const output = JSON.stringify(accounts);
		expect(output).not.toContain("access");
		expect(output).not.toContain("refresh");
	});
});
