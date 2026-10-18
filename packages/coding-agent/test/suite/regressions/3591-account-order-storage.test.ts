import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PooledCredential } from "@earendil-works/pi-ai/auth/pool/slots";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { listCredentialAccounts, orderCredentialAccounts } from "../../../src/core/credential-account-order.ts";
import {
	getCredentialAccounts,
	pinCredentialAccount,
	removeCredentialAccount,
} from "../../../src/core/credential-accounts.ts";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";
import { createRpcConnectionHandler } from "../../../src/modes/rpc/connection-handler.ts";
import { makeHarness, makeSink } from "../rpc-connection-harness.ts";

// senpi#3591: a provider's accounts can carry a user order. Selection takes the
// pin first, then the first unblocked account in the user order, then HRW for
// the accounts the order does not name. No order keeps today's HRW behavior.

const NAMES = ["alpha", "beta", "gamma"] as const;

let dir: string;
let storage: AuthStorage;
let repository: CredentialSlotRepository;

beforeEach(() => {
	dir = join(tmpdir(), `senpi-3591-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	storage = AuthStorage.create(join(dir, "auth.json"));
	repository = new CredentialSlotRepository(join(dir, "credential-pool-state.json"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

type PoolExtra = { pinned?: string; order?: string[] };

function pool(extra: PoolExtra = {}): PooledCredential {
	return {
		type: "api_key",
		key: "key-alpha",
		accounts: NAMES.map((name) => ({ name, key: `key-${name}`, source: "login" as const })),
		...extra,
	};
}

async function seed(provider: string, extra: PoolExtra = {}): Promise<void> {
	await storage.modify(provider, async () => pool(extra));
}

describe("senpi#3591 account order: storage and listing", () => {
	it("lists accounts in the user order, unnamed accounts after, and reports that an order is set", async () => {
		await seed("openai");
		await orderCredentialAccounts(storage, "openai", ["gamma", "alpha"], {}, repository);

		const listing = await listCredentialAccounts(storage, "openai", {}, repository);
		expect(listing.ordered).toBe(true);
		expect(listing.accounts.map((account) => account.name)).toEqual(["gamma", "alpha", "beta"]);
		expect((await getCredentialAccounts(storage, "openai", {}, repository)).map((account) => account.name)).toEqual([
			"gamma",
			"alpha",
			"beta",
		]);
	});

	it("clears the order with null, restoring the stored listing", async () => {
		await seed("openai");
		await orderCredentialAccounts(storage, "openai", ["gamma"], {}, repository);
		await orderCredentialAccounts(storage, "openai", null, {}, repository);

		const listing = await listCredentialAccounts(storage, "openai", {}, repository);
		expect(listing.ordered).toBe(false);
		expect(listing.accounts.map((account) => account.name)).toEqual(["alpha", "beta", "gamma"]);
		expect(storage.get("openai")).not.toHaveProperty("order");
	});

	it("rejects an unknown name, a duplicate, and an empty list without changing the stored order", async () => {
		await seed("openai", { order: ["beta"] });

		await expect(orderCredentialAccounts(storage, "openai", ["nope"], {}, repository)).rejects.toThrow(
			"Provider account not found: nope",
		);
		await expect(orderCredentialAccounts(storage, "openai", ["alpha", "alpha"], {}, repository)).rejects.toThrow(
			"Duplicate provider account in order: alpha",
		);
		await expect(orderCredentialAccounts(storage, "openai", [], {}, repository)).rejects.toThrow(
			"Account order must name at least one account",
		);
		expect((storage.get("openai") as PooledCredential).order).toEqual(["beta"]);
	});

	it("drops a removed account from the order, and the order key when it empties", async () => {
		await seed("openai", { order: ["beta", "gamma"] });

		await removeCredentialAccount(storage, "openai", "beta", {}, repository);
		expect((storage.get("openai") as PooledCredential).order).toEqual(["gamma"]);

		await removeCredentialAccount(storage, "openai", "gamma", {}, repository);
		expect(storage.get("openai")).not.toHaveProperty("order");
	});

	it("validates names against the credential it writes, so a concurrent removal cannot leave a name behind", async () => {
		await seed("openai");
		const modify = storage.modify.bind(storage);
		storage.modify = async (provider, fn) => {
			await modify(provider, async (current) =>
				current === undefined
					? current
					: {
							...current,
							accounts: (current as PooledCredential).accounts?.filter((slot) => slot.name !== "beta"),
						},
			);
			return modify(provider, fn);
		};

		await expect(orderCredentialAccounts(storage, "openai", ["beta"], {}, repository)).rejects.toThrow(
			"Provider account not found: beta",
		);
		expect(storage.get("openai")).not.toHaveProperty("order");
	});

	it("ignores a stale name in a stored order when listing", async () => {
		await seed("openai", { order: ["ghost", "beta"] });

		const listing = await listCredentialAccounts(storage, "openai", {}, repository);
		expect(listing.accounts.map((account) => account.name)).toEqual(["beta", "alpha", "gamma"]);
		expect(listing.ordered).toBe(true);
	});

	it("refuses an order for a provider with no stored credential, like a pin", async () => {
		await expect(
			orderCredentialAccounts(storage, "openai", ["OPENAI_API_KEY"], { OPENAI_API_KEY: "sk-env" }, repository),
		).rejects.toThrow("No stored credential for provider: openai");
	});
});

describe("senpi#3591 account order: RPC", () => {
	it("sets, lists and clears the order over account_order and get_provider_accounts", async () => {
		const collected = makeSink();
		const harness = makeHarness(dir);
		try {
			await harness.authStorage.modify("openai", async () => pool());
			const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
			const changed = collected.waitFor((message) => message.type === "auth_accounts_changed");

			await handler.handleInputLine(
				JSON.stringify({ id: "set", type: "account_order", provider: "openai", names: ["gamma", "alpha"] }),
			);
			expect(await collected.waitFor((message) => message.id === "set")).toMatchObject({
				type: "response",
				command: "account_order",
				success: true,
			});
			expect(await changed).toEqual({ type: "auth_accounts_changed", provider: "openai" });

			await handler.handleInputLine(
				JSON.stringify({ id: "list", type: "get_provider_accounts", provider: "openai" }),
			);
			const listed = await collected.waitFor((message) => message.id === "list");
			expect(listed).toMatchObject({ success: true, data: { ordered: true } });
			expect(
				(listed as unknown as { data: { accounts: { name: string }[] } }).data.accounts.map((entry) => entry.name),
			).toEqual(["gamma", "alpha", "beta"]);

			await handler.handleInputLine(
				JSON.stringify({ id: "bad", type: "account_order", provider: "openai", names: ["nope"] }),
			);
			expect(await collected.waitFor((message) => message.id === "bad")).toMatchObject({
				command: "account_order",
				success: false,
			});

			await handler.handleInputLine(
				JSON.stringify({ id: "string", type: "account_order", provider: "openai", names: "gamma" }),
			);
			expect(await collected.waitFor((message) => message.id === "string")).toMatchObject({
				command: "account_order",
				success: false,
				error: "account_order names must be an array of account names, or null to clear the order",
			});

			await handler.handleInputLine(
				JSON.stringify({ id: "clear", type: "account_order", provider: "openai", names: null }),
			);
			await collected.waitFor((message) => message.id === "clear");
			await handler.handleInputLine(
				JSON.stringify({ id: "again", type: "get_provider_accounts", provider: "openai" }),
			);
			const cleared = await collected.waitFor((message) => message.id === "again");
			expect(cleared).toMatchObject({ success: true, data: { ordered: false } });
			expect(
				(cleared as unknown as { data: { accounts: { name: string }[] } }).data.accounts.map((entry) => entry.name),
			).toEqual(["alpha", "beta", "gamma"]);
			expect(JSON.stringify(collected.messages())).not.toMatch(/key-(alpha|beta|gamma)/);
			await handler.dispose();
		} finally {
			harness.cleanup();
		}
	});

	it("pins still work beside an order", async () => {
		await seed("openai", { order: ["gamma"] });
		await pinCredentialAccount(storage, "openai", "beta", {}, repository);
		const listing = await listCredentialAccounts(storage, "openai", {}, repository);
		expect(listing.accounts.find((entry) => entry.pinned)?.name).toBe("beta");
		expect(listing.accounts[0]?.name).toBe("gamma");
	});
});
