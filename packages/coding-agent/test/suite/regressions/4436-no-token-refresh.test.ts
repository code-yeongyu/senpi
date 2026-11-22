/**
 * senpi#4436 (S7): the senpi-owned Claude login and its token refresh are gone. No anthropic-subscription code path
 * redeems a refresh token (a turn, the usage poll), a stored account that still holds tokens from the retired login
 * is never served, and a per-account `.credentials.json` is written only for `CLAUDE_CODE_OAUTH_TOKEN` env slots.
 * All tokens below are dummy strings; `fetch` is faked, so nothing leaves the process.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as accountsModule from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import * as authLaneModule from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import {
	overrideAuthLaneBoundary,
	queryWithAuthLane,
	resetAuthLaneBoundary,
} from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import { resolveAccountsDirectory } from "../../../src/core/extensions/builtin/anthropic-subscription/config-dir-credentials.ts";
import type { SdkQuery } from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import type { AnthropicSubscriptionTokenInjection } from "../../../src/core/extensions/builtin/anthropic-subscription/settings.ts";
import { listPollAccounts } from "../../../src/core/subscription-limits/usage-accounts.ts";

const PROVIDER = "anthropic-subscription";
const TOKEN_ENDPOINT = "platform.claude.com/v1/oauth/token";
const roots: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	resetAuthLaneBoundary();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "senpi-4436-no-token-refresh-"));
	roots.push(root);
	return root;
}

/** A raw store holding an account the retired login wrote, as an older build left it (no load-time sign-out). */
function storeWithRetiredLogin(expires: number): CredentialStore {
	let current: Credential | undefined = {
		type: "oauth",
		access: "claude-sdk-oauth-managed",
		refresh: "claude-sdk-oauth-managed",
		expires: 4102444800000,
		accounts: [
			{ name: "old", source: "login", access: "dummy-access-old", refresh: "dummy-refresh-old", expires },
			{
				name: "cli",
				source: "login",
				store: "claude-cli",
				dirId: "c".repeat(32),
				signInRequired: "legacy_sign_in_retired",
			},
		],
	} as Credential;
	return {
		read: async (providerId) => (providerId === PROVIDER ? current : undefined),
		list: async () => [],
		modify: async (providerId, fn) => {
			if (providerId !== PROVIDER) return fn(undefined);
			const next = await fn(current);
			if (next !== undefined) current = next;
			return current;
		},
		delete: async () => {
			current = undefined;
		},
	};
}

function tokenEndpointCalls(): () => number {
	const spy = vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async () => new Response('{"error":"invalid_grant"}', { status: 400 }));
	return () =>
		spy.mock.calls.filter(([input]) => String(input instanceof Request ? input.url : input).includes(TOKEN_ENDPOINT))
			.length;
}

async function runTurn(
	tokenInjection: AnthropicSubscriptionTokenInjection,
	spawned: Array<Record<string, unknown>>,
	pinnedAccount?: string,
) {
	const query: SdkQuery = (input) => {
		spawned.push({ ...(input.options?.env ?? {}) });
		throw new Error("scripted stop");
	};
	for await (const _message of queryWithAuthLane({
		prompt: "hi",
		query,
		providerSettings: { tokenInjection, accountFallback: false },
		buildOptions: () => ({}),
		...(pinnedAccount === undefined ? {} : { pinnedAccount }),
	})) {
		// drain
	}
}

describe("senpi#4436 no anthropic-subscription code path refreshes a token", () => {
	it("ships no refresh entry points", () => {
		const refreshExports = (module: object) => Object.keys(module).filter((name) => /refresh/i.test(name));
		expect(refreshExports(authLaneModule)).toEqual([]);
		expect(refreshExports(accountsModule)).toEqual([]);
	});

	it("a turn never redeems the refresh token of an expired account from the retired login", async () => {
		const calls = tokenEndpointCalls();
		const storage = storeWithRetiredLogin(1);
		overrideAuthLaneBoundary({
			createStore: () => storage,
			env: () => ({ PATH: "/usr/bin" }),
			getAgentDir: tempRoot,
		});
		const spawned: Array<Record<string, unknown>> = [];
		await expect(runTurn("oauth-slots", spawned)).rejects.toThrow(/authentication_failed/);
		expect(calls()).toBe(0);
		expect(spawned).toEqual([]);
	});

	it("the usage poll lists no account from the retired login and asks no token endpoint", async () => {
		const calls = tokenEndpointCalls();
		const storage = storeWithRetiredLogin(1);
		const accounts = await listPollAccounts({ store: storage, env: () => undefined, now: () => 10 });
		expect(accounts.filter((account) => account.provider === PROVIDER)).toEqual([]);
		expect(calls()).toBe(0);
	});

	it("writeConfigDirCredential is called only for env slots", async () => {
		tokenEndpointCalls();
		const agentDir = tempRoot();
		const storage = storeWithRetiredLogin(4102444000000);
		overrideAuthLaneBoundary({
			createStore: () => storage,
			env: () => ({ PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "dummy-env-token" }),
			getAgentDir: () => agentDir,
		});
		const accountsDir = resolveAccountsDirectory(agentDir);
		const pinnedToOld: Array<Record<string, unknown>> = [];
		await expect(runTurn("config-dir", pinnedToOld, "old")).rejects.toThrow();
		expect(pinnedToOld).toEqual([]);
		expect(existsSync(join(accountsDir, "old"))).toBe(false);

		const spawned: Array<Record<string, unknown>> = [];
		await expect(runTurn("config-dir", spawned)).rejects.toThrow(/scripted stop/);
		expect(spawned.map((env) => env.CLAUDE_CONFIG_DIR)).toEqual([join(accountsDir, "env")]);
		expect(existsSync(join(accountsDir, "env", ".credentials.json"))).toBe(true);
		expect(existsSync(join(accountsDir, "old"))).toBe(false);
	});
});
