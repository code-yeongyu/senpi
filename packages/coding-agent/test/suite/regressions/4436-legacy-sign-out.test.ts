/**
 * senpi#4436 (S6): accounts signed in through the retired senpi-owned Claude login are signed out at load, never
 * migrated. A stored subscription slot keeps its name, pin, order and model blocks but loses every token and needs
 * a sign-in again; the OAuth part of an `anthropic` entry is dropped without a copy (its API keys stay); env slots
 * and CLI slots are untouched; a second load writes nothing. Every surface then says to sign in again: the account
 * listing, the session-start notice, a turn, and Reconnect, which signs the same account in through the CLI.
 * All tokens below are dummy strings.
 */
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { listCredentialAccounts } from "../../../src/core/credential-account-order.ts";
import type { AnthropicSubscriptionCredential } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	overrideAuthLaneBoundary,
	queryWithAuthLane,
} from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import { createOAuthConfig } from "../../../src/core/extensions/builtin/anthropic-subscription/oauth-login.ts";
import { withAuthGuidance } from "../../../src/core/extensions/builtin/anthropic-subscription/stream-guidance.ts";
import type { SdkQuery } from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { resetScriptedSdk, SCRIPTED_PROVIDER } from "../../helpers/anthropic-subscription-scripted-sdk.ts";
import { cleanupFakeClaudeCliLogins, fakeClaudeCliLogin } from "../../support/fake-claude-cli-login.ts";

const roots: string[] = [];
const LATER = 4_102_444_000_000;
const MODEL_BLOCKS = { "claude-opus": { blockedUntil: LATER, blockReason: "rate_limit" } };

afterEach(() => {
	resetScriptedSdk();
	cleanupFakeClaudeCliLogins();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function grant(name: string, extra: Record<string, unknown> = {}) {
	return { name, access: `dummy-access-${name}`, refresh: `dummy-refresh-${name}`, expires: LATER, ...extra };
}

function legacyAuthFile(data: Record<string, unknown>): string {
	const root = mkdtempSync(join(tmpdir(), "senpi-4436-legacy-sign-out-"));
	roots.push(root);
	const path = join(root, "auth.json");
	writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
	return path;
}

function legacySubscription(): Record<string, unknown> {
	return {
		type: "oauth",
		access: "claude-sdk-oauth-managed",
		refresh: "claude-sdk-oauth-managed",
		expires: 4102444800000,
		pinned: "work",
		order: ["work", "imported-anthropic"],
		accounts: [
			grant("work", {
				displayName: "Work",
				source: "login",
				blockedUntil: LATER,
				blockReason: "auth_error",
				blockedAt: 1,
				authRecoveryGrant: "digest",
				modelBlocks: MODEL_BLOCKS,
			}),
			grant("imported-anthropic", { source: "import", importedFrom: "digest" }),
			{ name: "cli", source: "login", store: "claude-cli", dirId: "c".repeat(32), signedInAt: 5 },
		],
	};
}

function stored(path: string): Record<string, Record<string, unknown>> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, unknown>>;
}

function subscriptionOf(path: string): AnthropicSubscriptionCredential {
	return stored(path)[SCRIPTED_PROVIDER] as unknown as AnthropicSubscriptionCredential;
}

describe("senpi#4436 legacy Claude logins are signed out with a clear prompt", () => {
	it("(a) a legacy login slot becomes sign-in-required with no token fields and keeps pin/order", () => {
		const path = legacyAuthFile({ [SCRIPTED_PROVIDER]: legacySubscription() });
		AuthStorage.create(path);
		const subscription = subscriptionOf(path);
		const [work, imported, cli] = subscription.accounts ?? [];
		expect(work).toEqual({
			name: "work",
			displayName: "Work",
			source: "login",
			store: "claude-cli",
			dirId: expect.stringMatching(/^[0-9a-f]{32}$/),
			signInRequired: "legacy_sign_in_retired",
			modelBlocks: MODEL_BLOCKS,
		});
		expect(imported).toEqual({
			name: "imported-anthropic",
			source: "login",
			store: "claude-cli",
			dirId: expect.stringMatching(/^[0-9a-f]{32}$/),
			signInRequired: "legacy_sign_in_retired",
		});
		expect(cli).toEqual({ name: "cli", source: "login", store: "claude-cli", dirId: "c".repeat(32), signedInAt: 5 });
		expect(work?.store === "claude-cli" && imported?.store === "claude-cli" && work.dirId !== imported.dirId).toBe(
			true,
		);
		expect(subscription).toMatchObject({ pinned: "work", order: ["work", "imported-anthropic"] });
		expect(readFileSync(path, "utf8")).not.toMatch(/dummy-(access|refresh)/);
	});

	it("(b) an anthropic OAuth entry loses its OAuth part, keeps its API-key slots, and creates no subscription slot", () => {
		const pooled = legacyAuthFile({
			anthropic: {
				type: "oauth",
				...grant("flat"),
				pinned: "team-key",
				accounts: [grant("personal"), { name: "team-key", key: "dummy-key" }],
			},
		});
		AuthStorage.create(pooled);
		expect(stored(pooled)).toEqual({
			anthropic: {
				type: "api_key",
				key: "dummy-key",
				pinned: "team-key",
				accounts: [{ name: "team-key", key: "dummy-key" }],
			},
		});

		const single = legacyAuthFile({
			anthropic: { type: "oauth", ...grant("only") },
			openai: { type: "api_key", key: "k" },
		});
		AuthStorage.create(single);
		expect(stored(single)).toEqual({ openai: { type: "api_key", key: "k" } });
	});

	it("(c) env slots are untouched", () => {
		const subscription = {
			type: "oauth",
			access: "claude-sdk-oauth-managed",
			refresh: "claude-sdk-oauth-managed",
			expires: 4102444800000,
			accounts: [grant("env-1", { source: "env" })],
			slotState: { "env:CLAUDE_CODE_OAUTH_TOKEN": { blockReason: "rate_limit", blockedUntil: LATER } },
		};
		const path = legacyAuthFile({ [SCRIPTED_PROVIDER]: subscription });
		const before = readFileSync(path, "utf8");
		AuthStorage.create(path);
		expect(readFileSync(path, "utf8")).toBe(before);
	});

	it("(d) a second load writes nothing", () => {
		const path = legacyAuthFile({
			[SCRIPTED_PROVIDER]: legacySubscription(),
			anthropic: { type: "oauth", ...grant("old") },
		});
		AuthStorage.create(path);
		const first = readFileSync(path, "utf8");
		const firstStamp = statSync(path).mtimeMs;
		AuthStorage.create(path).reload();
		expect(readFileSync(path, "utf8")).toBe(first);
		expect(statSync(path).mtimeMs).toBe(firstStamp);
	});

	it("(e) get_provider_accounts reports signIn needs_sign_in", async () => {
		const storage = AuthStorage.create(legacyAuthFile({ [SCRIPTED_PROVIDER]: legacySubscription() }));
		const listing = await listCredentialAccounts(storage, SCRIPTED_PROVIDER);
		expect(listing.accounts.map(({ name, signIn }) => ({ name, signIn }))).toEqual([
			{ name: "work", signIn: "needs_sign_in" },
			{ name: "imported-anthropic", signIn: "needs_sign_in" },
			{ name: "cli", signIn: "signed_in" },
		]);
	});

	it("the session-start notice names the accounts to sign in again", () => {
		const storage = AuthStorage.create(legacyAuthFile({ [SCRIPTED_PROVIDER]: legacySubscription() }));
		const notices = storage.takePendingNotices({ persistSeen: false }).map((notice) => notice.message);
		expect(notices).toEqual([
			"Claude sign-in changed. Sign in again with Claude to keep using: work, imported-anthropic. Run /login anthropic-subscription.",
		]);
	});

	it("(f) a turn with only signed-out slots fails with the sign-in-again error", async () => {
		const subscription = legacySubscription();
		subscription.accounts = (subscription.accounts as Record<string, unknown>[]).slice(0, 2);
		const storage = AuthStorage.create(legacyAuthFile({ [SCRIPTED_PROVIDER]: subscription }));
		overrideAuthLaneBoundary({ createStore: () => storage, env: () => ({ PATH: "/usr/bin" }) });
		const spawned: unknown[] = [];
		const query: SdkQuery = (input) => {
			spawned.push(input);
			throw new Error("no turn may start");
		};
		const turn = async () => {
			for await (const _message of queryWithAuthLane({
				prompt: "hi",
				query,
				providerSettings: { tokenInjection: "oauth-slots" },
				buildOptions: () => ({}),
			})) {
				// drain
			}
		};
		const failure = await turn().then(
			() => undefined,
			(error: unknown) => error,
		);
		expect(failure).toBeInstanceOf(Error);
		const message = (failure as Error).message;
		expect(message).toContain(
			"Claude sign-in changed. Sign in again with Claude to keep using: work, imported-anthropic. Run /login anthropic-subscription.",
		);
		expect(withAuthGuidance(failure, message)).toBe(message);
		expect(spawned).toEqual([]);
	});

	it("(g) Reconnect on a signed-out slot produces a signed-in CLI slot under the same name", async () => {
		const subscription = legacySubscription();
		subscription.accounts = (subscription.accounts as Record<string, unknown>[]).slice(0, 1);
		const storage = AuthStorage.create(legacyAuthFile({ [SCRIPTED_PROVIDER]: subscription }));
		const signedOut = (storage.get(SCRIPTED_PROVIDER) as AnthropicSubscriptionCredential).accounts?.[0];
		expect(signedOut).toMatchObject({ name: "work", signInRequired: "legacy_sign_in_retired" });
		const cli = fakeClaudeCliLogin();
		const config = createOAuthConfig({
			readCurrent: async () => storage.get(SCRIPTED_PROVIDER) as AnthropicSubscriptionCredential | undefined,
			claudeCli: { ...cli, store: () => storage },
		});
		const credential = (await config.login({
			onPrompt: async (prompt) => (prompt.message.startsWith("Name for this account (") ? "work" : ""),
		})) as AnthropicSubscriptionCredential;
		expect(credential.accounts?.map((slot) => slot.name)).toEqual(["work"]);
		const [work] = credential.accounts ?? [];
		expect(work).toMatchObject({
			name: "work",
			displayName: "Work",
			store: "claude-cli",
			dirId: expect.stringMatching(/^[0-9a-f]{32}$/),
			profile: { email: expect.any(String) },
		});
		expect(work).not.toHaveProperty("signInRequired");
		expect(credential.pinned).toBe("work");
	});
});
