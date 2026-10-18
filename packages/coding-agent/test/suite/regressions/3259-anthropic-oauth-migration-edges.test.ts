import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { migrateAnthropicOAuthToSubscription } from "../../../src/core/anthropic-oauth-migration.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import type { AnthropicSubscriptionCredential } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";

type Store = Record<string, Credential>;

function subscriptionOf(data: Store): AnthropicSubscriptionCredential | undefined {
	return data["anthropic-subscription"] as AnthropicSubscriptionCredential | undefined;
}

describe("the #3259 move never drops a live grant or the store", () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("also moves top-level OAuth fields that match no pool slot", () => {
		const result = migrateAnthropicOAuthToSubscription({
			anthropic: {
				type: "oauth",
				access: "flat-access",
				refresh: "flat-refresh",
				expires: 9,
				accounts: [{ name: "default", access: "slot-access", refresh: "slot-refresh", expires: 1 }],
			} as Credential,
		});
		expect(result.migrated).toBe(true);
		expect(
			subscriptionOf(result.data)
				?.accounts?.map((slot) => slot.refresh)
				.sort(),
		).toEqual(["flat-refresh", "slot-refresh"]);
	});

	it("skips and reports a subscription entry whose accounts are not account objects", () => {
		for (const accounts of [{ bad: true }, [null]]) {
			const data: Store = {
				anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 },
				"anthropic-subscription": {
					type: "oauth",
					access: "s",
					refresh: "s",
					expires: 1,
					accounts,
				} as unknown as Credential,
			};
			const result = migrateAnthropicOAuthToSubscription(data);
			expect(result).toMatchObject({ migrated: false, data });
			expect(result.skipped).toBeTypeOf("string");
		}
	});

	it("keeps every other provider readable when the subscription entry is malformed", async () => {
		dir = mkdtempSync(join(tmpdir(), "auth-3259-edge-"));
		const authPath = join(dir, "auth.json");
		const original = JSON.stringify({
			openai: { type: "api_key", key: "sk-openai" },
			anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 },
			"anthropic-subscription": { type: "oauth", access: "s", refresh: "s", expires: 1, accounts: { bad: true } },
		});
		writeFileSync(authPath, original, { mode: 0o600 });
		const store = AuthStorage.create(authPath);
		expect(await store.read("openai")).toEqual({ type: "api_key", key: "sk-openai" });
		expect(readFileSync(authPath, "utf-8")).toBe(original);
	});

	it("never re-imports a copied grant the user removed before the source was retired", () => {
		const copied = migrateAnthropicOAuthToSubscription({
			anthropic: { type: "oauth", access: "a", refresh: "old", expires: 1 },
		}).data;
		const removed: Store = {
			...copied,
			"anthropic-subscription": { ...subscriptionOf(copied), accounts: [] } as Credential,
		};
		const next = migrateAnthropicOAuthToSubscription(removed);
		expect(subscriptionOf(next.data)?.accounts).toEqual([]);
		expect(next.data.anthropic).toBeUndefined();
	});

	it("copies a refresh token shared by two source slots once, and points the pin at that copy", () => {
		const result = migrateAnthropicOAuthToSubscription({
			anthropic: {
				type: "oauth",
				access: "a",
				refresh: "r",
				expires: 1,
				accounts: [
					{ name: "x", access: "a", refresh: "r", expires: 1 },
					{ name: "y", access: "a", refresh: "r", expires: 1 },
				],
				pinned: "y",
			} as Credential,
		});
		const subscription = subscriptionOf(result.data);
		expect(subscription?.accounts?.map((slot) => slot.refresh)).toEqual(["r"]);
		expect(subscription?.pinned).toBe(subscription?.accounts?.[0]?.name);
	});

	it("retires without a second copy after the copied account's token rotated", () => {
		const copied = migrateAnthropicOAuthToSubscription({
			anthropic: { type: "oauth", access: "a", refresh: "r1", expires: 1 },
		}).data;
		const subscription = subscriptionOf(copied);
		const rotated: Store = {
			...copied,
			"anthropic-subscription": {
				...subscription,
				accounts: subscription?.accounts?.map((slot) => ({ ...slot, refresh: "r2", access: "a2" })),
			} as Credential,
		};
		const next = migrateAnthropicOAuthToSubscription(rotated);
		expect(next.data.anthropic).toBeUndefined();
		expect(subscriptionOf(next.data)?.accounts?.map((slot) => slot.refresh)).toEqual(["r2"]);
	});

	it("pins the existing subscription account when the pinned source slot is already there", () => {
		const result = migrateAnthropicOAuthToSubscription({
			anthropic: {
				type: "oauth",
				access: "a",
				refresh: "r",
				expires: 1,
				accounts: [{ name: "work", access: "a", refresh: "r", expires: 1 }],
				pinned: "work",
			} as Credential,
			"anthropic-subscription": {
				type: "oauth",
				access: "m",
				refresh: "m",
				expires: 1,
				accounts: [{ name: "mine", access: "a", refresh: "r", expires: 1, source: "login" }],
			} as Credential,
		});
		expect(subscriptionOf(result.data)?.pinned).toBe("mine");
		expect(subscriptionOf(result.data)?.accounts).toHaveLength(1);
	});

	it("projects the pinned API-key slot onto the remaining top-level key", () => {
		const copied = migrateAnthropicOAuthToSubscription({
			anthropic: {
				type: "oauth",
				access: "a",
				refresh: "r",
				expires: 1,
				accounts: [
					{ name: "default", access: "a", refresh: "r", expires: 1 },
					{ name: "k1", key: "sk-1" },
					{ name: "k2", key: "sk-2" },
				],
				pinned: "k2",
			} as Credential,
		});
		const result = migrateAnthropicOAuthToSubscription(copied.data);
		expect(result.data.anthropic).toMatchObject({ type: "api_key", key: "sk-2", pinned: "k2" });
	});
});
