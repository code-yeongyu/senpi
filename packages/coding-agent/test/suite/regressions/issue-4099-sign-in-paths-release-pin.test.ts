import type { Api, Credential, Model } from "@earendil-works/pi-ai";
import { mergeRefreshed, mergeRefreshedSlot, type PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { credentialRecoveryRevision } from "../../../src/core/credential-recovery-revision.ts";
import { registerCursorCliAccountCommand } from "../../../src/core/extensions/builtin/cursor-cli-oauth/account-command.ts";
import {
	addAccount,
	type CursorCliOauthCredential,
	emptyCredential,
} from "../../../src/core/extensions/builtin/cursor-cli-oauth/accounts.ts";
import { CursorCliGenerationGuard } from "../../../src/core/extensions/builtin/cursor-cli-oauth/diagnostics.ts";
import { createCursorCliOauthCredentialReader } from "../../../src/core/extensions/builtin/cursor-cli-oauth/native-bootstrap.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../../../src/core/extensions/types.ts";
import { RetryFallbackController } from "../../../src/core/retry-fallback/controller.ts";
import { SelectorCooldowns } from "../../../src/core/retry-fallback/cooldown.ts";

const CURSOR = "cursor-cli-oauth";
const SYNTHETIC = "synthetic";
const SUBSCRIPTION = "anthropic-subscription";
const billing = { errorMessage: '429 {"error":{"type":"usage_not_included","message":"not in your plan"}}' };

function model(provider: string, id: string): Model<Api> {
	return { ...getModel("anthropic", "claude-opus-4-5"), provider, id };
}

function oauth(access: string): Credential {
	return { type: "oauth", access, refresh: `${access}-r`, expires: Date.now() + 3_600_000 };
}

function cursorSlot(name: string) {
	return {
		name,
		access: `${name}-a`,
		refresh: `${name}-r`,
		expires: Date.now() + 3_600_000,
		source: "import" as const,
	};
}

function createController(storage: AuthStorage, provider: string) {
	const original = model(provider, "original");
	const fallback = model("kimi-coding", "kimi-k3");
	const models = [original, fallback];
	let current: { model: Model<Api> } = { model: original };
	const controller = new RetryFallbackController({
		getSettings: () => ({ modelFallback: true, chains: { [`${provider}/original`]: ["kimi-coding/kimi-k3"] } }),
		registry: {
			find: (p, id) => models.find((entry) => entry.provider === p && entry.id === id),
			getAll: () => models,
		},
		cooldowns: new SelectorCooldowns(() => 0),
		logger: { debug: () => {}, info: () => {}, warn: () => {} },
		switchModel: async (next) => {
			current = { model: next };
		},
		emit: () => {},
		getCurrentSelector: () => current,
		isAuthAvailable: () => true,
		recoveryRevision: (p) => credentialRecoveryRevision(storage, p),
	});
	return controller;
}

async function runCursorAccountCommand(storage: AuthStorage, args: string): Promise<void> {
	let registered: Pick<RegisteredCommand, "handler"> | undefined;
	const pi = {
		registerCommand: (name: string, command: Pick<RegisteredCommand, "handler">) => {
			if (name === "cursor-account") registered = command;
		},
		on: () => {},
	} as unknown as ExtensionAPI;
	registerCursorCliAccountCommand(pi, {
		generation: new CursorCliGenerationGuard(),
		persistEnabled: () => {},
		importCredential: async (current) => addAccount(current, cursorSlot("imported")),
		readNativeCredential: () => oauth("native"),
	});
	const errors: string[] = [];
	const ctx = {
		hasUI: false,
		cwd: "/nonexistent/issue-4099",
		signal: undefined,
		modelRegistry: {
			authStorage: storage,
			modelRuntime: { refresh: async () => ({ aborted: false, errors: new Map() }) },
		},
		ui: {
			notify: (message: string, type?: string) => {
				if (type === "error" || type === "warning") errors.push(message);
			},
		},
	} as unknown as ExtensionCommandContext;
	await registered?.handler(args, ctx);
	expect(errors).toEqual([]);
}

type Row = {
	path: string;
	provider: string;
	seed: (storage: AuthStorage) => Promise<void>;
	write: (storage: AuthStorage) => Promise<void>;
	signIn: boolean;
};

const seedPooledCursor = async (storage: AuthStorage) => {
	storage.set(CURSOR, addAccount(emptyCredential(), cursorSlot("alpha")));
};

const seedSubscription = async (storage: AuthStorage) => {
	storage.set(SUBSCRIPTION, oauth("subscribed"));
};

/** A fresh `anthropic` OAuth login; the next store parse migrates it into the subscription lane. */
const signInAnthropic = async (storage: AuthStorage) => {
	storage.set("anthropic", oauth("anthropic-fresh"));
	await storage.list();
};

const rows: Row[] = [
	{
		path: "anthropic OAuth login migrated into anthropic-subscription",
		provider: SUBSCRIPTION,
		seed: seedSubscription,
		write: async (storage) => {
			await signInAnthropic(storage);
			expect(storage.listSlots(SUBSCRIPTION).map((slot) => slot.source)).toContain("import");
		},
		signIn: true,
	},
	{
		path: "re-parsing a store whose anthropic grant is already migrated",
		provider: SUBSCRIPTION,
		seed: async (storage) => {
			await seedSubscription(storage);
			await signInAnthropic(storage);
		},
		write: async (storage) => {
			await storage.list();
			storage.reload();
			await storage.list();
		},
		signIn: false,
	},
	{
		path: "AuthStorage.setSlot adding a new slot",
		provider: SYNTHETIC,
		seed: async (storage) => void storage.set(SYNTHETIC, oauth("first")),
		write: async (storage) => void storage.setSlot(SYNTHETIC, { name: "added", key: "added-key", source: "login" }),
		signIn: true,
	},
	{
		path: "AuthStorage.setSlot updating an existing slot",
		provider: SYNTHETIC,
		seed: async (storage) => void storage.set(SYNTHETIC, oauth("first")),
		write: async (storage) => {
			const [existing] = storage.listSlots(SYNTHETIC);
			if (!existing) throw new Error("seed stored no slot");
			storage.setSlot(SYNTHETIC, { ...existing, access: "rotated-a" });
		},
		signIn: false,
	},
	{
		path: "AuthStorage.set (login, RPC login_api_key)",
		provider: SYNTHETIC,
		seed: async (storage) => void storage.set(SYNTHETIC, oauth("first")),
		write: async (storage) => void storage.set(SYNTHETIC, oauth("second")),
		signIn: true,
	},
	{
		path: "/cursor-account import local",
		provider: CURSOR,
		seed: seedPooledCursor,
		write: (storage) => runCursorAccountCommand(storage, "import local"),
		signIn: true,
	},
	{
		path: "/cursor-account import native",
		provider: CURSOR,
		seed: seedPooledCursor,
		write: (storage) => runCursorAccountCommand(storage, "import native"),
		signIn: true,
	},
	{
		path: "cursor-cli-oauth native first-run bootstrap",
		provider: CURSOR,
		seed: async () => {},
		write: async (storage) => {
			const read = createCursorCliOauthCredentialReader({
				store: storage,
				readNativeCredential: () => oauth("native"),
				canBootstrap: () => true,
			});
			const bootstrapped = (await read()) as CursorCliOauthCredential | undefined;
			expect(bootstrapped?.accounts?.map((account) => account.name)).toEqual(["native"]);
		},
		signIn: true,
	},
	{
		path: "pooled token refresh (mergeRefreshedSlot)",
		provider: SYNTHETIC,
		seed: async (storage) => {
			storage.set(SYNTHETIC, oauth("first"));
			storage.set(SYNTHETIC, oauth("second"));
		},
		write: async (storage) => {
			await storage.modify(SYNTHETIC, async (current) =>
				current ? mergeRefreshedSlot(current as PooledCredential, "default", oauth("rotated")) : current,
			);
		},
		signIn: false,
	},
	{
		path: "single-account token refresh (mergeRefreshed drops the id)",
		provider: SYNTHETIC,
		seed: async (storage) => void storage.set(SYNTHETIC, oauth("first")),
		write: async (storage) => {
			await storage.modify(SYNTHETIC, async (current) =>
				current ? mergeRefreshed(current as PooledCredential, oauth("rotated")) : current,
			);
		},
		signIn: false,
	},
];

describe("every path that adds a signed-in account stamps a login id; refreshes never mint one (senpi#4099)", () => {
	it.each(rows)("$path", async (row) => {
		const storage = AuthStorage.inMemory();
		await row.seed(storage);
		const controller = createController(storage, row.provider);
		await controller.tryFallback("billing", billing);
		expect(controller.activeState?.pinnedByBilling).toBe(true);
		const before = storage.get(row.provider)?.loginId ?? "";

		await row.write(storage);
		const after = storage.get(row.provider)?.loginId ?? "";
		const released = await controller.maybeRestorePrimary("cooldown-expiry", "turn");

		expect({ minted: after !== "" && after !== before, released }).toEqual({
			minted: row.signIn,
			released: row.signIn,
		});
	});
});
