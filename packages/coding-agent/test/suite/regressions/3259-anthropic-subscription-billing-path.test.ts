import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Credential, Model } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateAnthropicOAuthToSubscription } from "../../../src/core/anthropic-oauth-migration.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import type { AnthropicSubscriptionCredential } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { findInitialModel, restoreModelFromSession } from "../../../src/core/model-resolver.ts";
import { usageLimitScope } from "../../../src/core/retry-fallback/usage-limit.ts";

// Regression for https://github.com/code-yeongyu/senpi/issues/3259: a Claude subscription logged in
// through the direct `anthropic` provider is billed by Anthropic as a third-party app (extra usage),
// and the fallback chain replayed the same rejection on every Anthropic model. The subscription must
// run through the Agent SDK lane (`anthropic-subscription`) and the rejection must end the turn once.

const THIRD_PARTY_400 =
	'400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."}}';

type Store = Record<string, Credential>;

function settle(data: Store): Store {
	let current = data;
	for (let step = 0; step < 5; step++) {
		const result = migrateAnthropicOAuthToSubscription(current);
		if (!result.migrated) return current;
		current = result.data;
	}
	throw new Error("migration did not settle");
}

function subscriptionOf(data: Store): AnthropicSubscriptionCredential | undefined {
	return data["anthropic-subscription"] as AnthropicSubscriptionCredential | undefined;
}

describe("subscription OAuth grant moves to the Agent SDK lane (#3259)", () => {
	it("copies a flat grant first and retires the source only on a later pass", () => {
		const source: Store = { anthropic: { type: "oauth", access: "acc-1", refresh: "ref-1", expires: 42 } };
		const copied = migrateAnthropicOAuthToSubscription(source);
		expect(copied.migrated).toBe(true);
		expect(copied.data.anthropic).toMatchObject(source.anthropic as object);
		expect(copied.data.anthropic).toHaveProperty("importedToSubscription");
		expect(subscriptionOf(copied.data)?.accounts).toMatchObject([
			{ name: "imported-anthropic", access: "acc-1", refresh: "ref-1", expires: 42, source: "import" },
		]);
		const retired = migrateAnthropicOAuthToSubscription(copied.data);
		expect(retired.migrated).toBe(true);
		expect(retired.data.anthropic).toBeUndefined();
		expect(subscriptionOf(retired.data)?.accounts).toEqual(subscriptionOf(copied.data)?.accounts);
		expect(migrateAnthropicOAuthToSubscription(retired.data).migrated).toBe(false);
	});

	it("moves every pooled slot next to existing subscription accounts without overwriting them", () => {
		const settled = settle({
			anthropic: {
				type: "oauth",
				access: "acc-1",
				refresh: "ref-1",
				expires: 1,
				accounts: [
					{ name: "default", access: "acc-1", refresh: "ref-1", expires: 1 },
					{ name: "work", access: "acc-2", refresh: "ref-2", expires: 2 },
				],
			} as Credential,
			"anthropic-subscription": {
				type: "oauth",
				access: "claude-sdk-oauth-managed",
				refresh: "claude-sdk-oauth-managed",
				expires: 4102444800000,
				accounts: [{ name: "imported-anthropic", access: "keep", refresh: "keep", expires: 9, source: "login" }],
			} as Credential,
		});
		expect(settled.anthropic).toBeUndefined();
		expect(subscriptionOf(settled)?.accounts?.map((slot) => [slot.name, slot.refresh])).toEqual([
			["imported-anthropic", "keep"],
			["imported-anthropic-default", "ref-1"],
			["imported-anthropic-work", "ref-2"],
		]);
	});

	it("moves only the OAuth slots of a mixed pool and keeps the API key slot in place", () => {
		const settled = settle({
			anthropic: {
				type: "oauth",
				access: "acc-1",
				refresh: "ref-1",
				expires: 1,
				accounts: [
					{ name: "default", access: "acc-1", refresh: "ref-1", expires: 1, source: "login" },
					{ name: "login-2", key: "sk-ant-api03-KEEP", source: "login" },
				],
				pinned: "login-2",
			} as Credential,
		});
		expect(settled.anthropic).toEqual({
			type: "api_key",
			key: "sk-ant-api03-KEEP",
			accounts: [{ name: "login-2", key: "sk-ant-api03-KEEP", source: "login" }],
			pinned: "login-2",
		});
		expect(subscriptionOf(settled)?.accounts?.map((slot) => slot.refresh)).toEqual(["ref-1"]);
	});

	it("leaves an OAuth entry it cannot parse untouched and reports why", () => {
		const malformed: Store = {
			anthropic: { type: "oauth", access: "acc", refresh: "ref", expires: "soon" } as unknown as Credential,
		};
		const result = migrateAnthropicOAuthToSubscription(malformed);
		expect(result.migrated).toBe(false);
		expect(result.data).toBe(malformed);
		expect(result.skipped).toBeTypeOf("string");
	});

	it("carries the pin and display names of moved slots", () => {
		const result = migrateAnthropicOAuthToSubscription({
			anthropic: {
				type: "oauth",
				access: "acc-1",
				refresh: "ref-1",
				expires: 1,
				accounts: [
					{ name: "default", access: "acc-1", refresh: "ref-1", expires: 1 },
					{ name: "work", displayName: "Work", access: "acc-2", refresh: "ref-2", expires: 2 },
				],
				pinned: "work",
			} as Credential,
		});
		const subscription = subscriptionOf(result.data);
		expect(subscription?.pinned).toBe("imported-anthropic-work");
		expect(subscription?.accounts?.find((slot) => slot.name === "imported-anthropic-work")?.displayName).toBe("Work");
	});

	it("leaves an Anthropic API key and an already-migrated store untouched", () => {
		const apiKey: Store = { anthropic: { type: "api_key", key: "sk-ant-api03-x" } };
		expect(migrateAnthropicOAuthToSubscription(apiKey)).toEqual({ data: apiKey, migrated: false });
		const done: Store = { other: { type: "api_key", key: "k" } };
		expect(migrateAnthropicOAuthToSubscription(done)).toEqual({ data: done, migrated: false });
	});
});

function subscriptionModel(id: string): Model<Api> {
	const base = getModels("anthropic").find((model) => model.id === id);
	if (!base) throw new Error(`missing anthropic model ${id}`);
	return { ...base, provider: "anthropic-subscription" } as Model<Api>;
}

function runtimeWithAuthOn(provider: string): Parameters<typeof findInitialModel>[0]["modelRuntime"] {
	const models: Model<Api>[] = [...(getModels("anthropic") as Model<Api>[]), subscriptionModel("claude-opus-5-5")];
	return {
		getAvailableSnapshot: () => models.filter((model) => model.provider === provider),
		getModel: (p: string, id: string) => models.find((model) => model.provider === p && model.id === id),
		hasConfiguredAuth: (p: string) => p === provider,
	} as unknown as Parameters<typeof findInitialModel>[0]["modelRuntime"];
}

describe("saved anthropic selections follow the moved subscription (#3259)", () => {
	it("starts a saved anthropic default on the same model in the subscription lane", async () => {
		const initial = await findInitialModel({
			scopedModels: [],
			isContinuing: false,
			defaultProvider: "anthropic",
			defaultModelId: "claude-opus-5-5",
			modelRuntime: runtimeWithAuthOn("anthropic-subscription"),
		});
		expect(initial.model).toMatchObject({ provider: "anthropic-subscription", id: "claude-opus-5-5" });
		expect(initial.provenance).toBe("settings");
	});

	it("restores an anthropic session onto the subscription lane without a fallback warning", async () => {
		const restored = await restoreModelFromSession(
			"anthropic",
			"claude-opus-5-5",
			undefined,
			false,
			runtimeWithAuthOn("anthropic-subscription"),
		);
		expect(restored.model).toMatchObject({ provider: "anthropic-subscription", id: "claude-opus-5-5" });
		expect(restored.fallbackMessage).toBeUndefined();
	});

	it("names the lane it actually restored in the restore notice", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await restoreModelFromSession(
				"anthropic",
				"claude-opus-5-5",
				undefined,
				true,
				runtimeWithAuthOn("anthropic-subscription"),
			);
			expect(log.mock.calls.flat().join(" ")).toContain("anthropic-subscription/claude-opus-5-5");
		} finally {
			log.mockRestore();
		}
	});

	it("keeps the direct anthropic provider when it still holds its own auth", async () => {
		const restored = await restoreModelFromSession(
			"anthropic",
			"claude-opus-5-5",
			undefined,
			false,
			runtimeWithAuthOn("anthropic"),
		);
		expect(restored.model).toMatchObject({ provider: "anthropic", id: "claude-opus-5-5" });
	});
});

describe("the move runs once at the auth.json load seam behind a private backup (#3259)", () => {
	let dir: string | undefined;
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it("copies, then retires behind 0600 backups, and settles with no further writes", async () => {
		dir = mkdtempSync(join(tmpdir(), "auth-3259-"));
		const authPath = join(dir, "auth.json");
		const original = JSON.stringify({
			openai: { type: "api_key", key: "sk-openai" },
			anthropic: { type: "oauth", access: "acc-1", refresh: "ref-1", expires: 42 },
		});
		writeFileSync(authPath, original, { mode: 0o600 });
		const backups = () =>
			readdirSync(dir ?? "")
				.filter((name) => name.startsWith("auth.json.backup-"))
				.sort();

		const first = AuthStorage.create(authPath);
		expect(await first.read("anthropic-subscription")).toMatchObject({
			accounts: [{ name: "imported-anthropic", refresh: "ref-1" }],
		});
		expect(await first.read("openai")).toEqual({ type: "api_key", key: "sk-openai" });
		const second = AuthStorage.create(authPath);
		expect(await second.read("anthropic")).toBeUndefined();
		expect(await second.read("anthropic-subscription")).toMatchObject({ accounts: [{ refresh: "ref-1" }] });

		const written = backups();
		expect(written.length).toBeGreaterThanOrEqual(1);
		expect(readFileSync(join(dir, written[0] ?? ""), "utf-8")).toBe(original);
		for (const name of written) expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);

		const settled = readFileSync(authPath, "utf-8");
		const third = AuthStorage.create(authPath);
		expect(await third.read("anthropic-subscription")).toMatchObject({ accounts: [{ refresh: "ref-1" }] });
		expect(readFileSync(authPath, "utf-8")).toBe(settled);
		expect(backups()).toEqual(written);
	});
});

describe("third-party billing rejection ends the Anthropic account, not one model (#3259)", () => {
	it("scopes the rejection to the whole account so the chain skips sibling Anthropic models", () => {
		expect(usageLimitScope(THIRD_PARTY_400)).toBe("account");
	});
});
