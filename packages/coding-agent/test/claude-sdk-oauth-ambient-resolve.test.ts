import { describe, expect, it, vi } from "vitest";
import { resolveProviderAuth } from "../../ai/src/auth/resolve.ts";
import {
	addAccount,
	emptyCredential,
	SENTINEL_OAUTH_FIELDS,
} from "../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";
import { createOAuthConfig } from "../src/core/extensions/builtin/claude-sdk-oauth/oauth-login.ts";
import { authContext, composedProvider, credentialStore } from "./support/claude-sdk-oauth-provider.ts";

describe("claude-sdk-oauth ambient auth resolution", () => {
	it("resolves request auth from an authenticated ambient Claude CLI with nothing stored", async () => {
		const provider = composedProvider(async () => true);

		const resolved = await resolveProviderAuth(provider, credentialStore(), authContext());

		expect(resolved?.auth.apiKey).toBe(SENTINEL_OAUTH_FIELDS.access);
	});

	it("resolves request auth from CLAUDE_CODE_OAUTH_TOKEN with nothing stored", async () => {
		const provider = composedProvider(async () => false);

		const resolved = await resolveProviderAuth(
			provider,
			credentialStore(),
			authContext({ CLAUDE_CODE_OAUTH_TOKEN: "env-token" }),
		);

		expect(resolved?.auth.apiKey).toBe(SENTINEL_OAUTH_FIELDS.access);
		expect(resolved?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "env-token" });
	});

	it("reports not configured when ambient auth is logged out and nothing is stored", async () => {
		const provider = composedProvider(async () => false);

		expect(await resolveProviderAuth(provider, credentialStore(), authContext())).toBeUndefined();
	});

	it("rejects a persisted empty OAuth envelope when ambient auth is logged out", async () => {
		const provider = composedProvider(async () => false);

		expect(await resolveProviderAuth(provider, credentialStore(emptyCredential()), authContext())).toBeUndefined();
	});

	it("preserves request auth after a persisted empty OAuth envelope", async () => {
		const provider = composedProvider(async () => false);
		const requestEnvironment = { CLAUDE_CODE_OAUTH_TOKEN: "request-token" };
		const resolved = await resolveProviderAuth(
			provider,
			credentialStore(emptyCredential()),
			authContext({ CLAUDE_CODE_OAUTH_TOKEN: "host-token" }),
			{ env: requestEnvironment },
		);

		expect(resolved?.env).toEqual(requestEnvironment);
	});

	it("composes configured headers and authHeader identically for ambient and stored OAuth", async () => {
		const provider = composedProvider(async () => true, {
			headers: { "User-Agent": "must-survive" },
			authHeader: true,
		});
		const stored = addAccount(emptyCredential(), {
			name: "stored",
			access: "stored-token",
			refresh: "stored-refresh",
			expires: Date.now() + 60 * 60_000,
			source: "login",
		});

		const ambient = await resolveProviderAuth(provider, credentialStore(), authContext());
		const managed = await resolveProviderAuth(provider, credentialStore(stored), authContext());

		expect(ambient?.auth).toEqual(managed?.auth);
		expect(ambient?.auth.headers).toEqual({
			"User-Agent": "must-survive",
			Authorization: `Bearer ${SENTINEL_OAUTH_FIELDS.access}`,
		});
	});

	it("rejects an unrelated explicit key for an ambient-only OAuth provider", async () => {
		const provider = composedProvider(async () => true);

		expect(
			await resolveProviderAuth(provider, credentialStore(), authContext(), {
				apiKey: "sk-ant-unrelated",
			}),
		).toBeUndefined();
	});

	it("replays the synthetic marker through a valid stored OAuth account", async () => {
		const provider = composedProvider(async () => false);
		const stored = addAccount(emptyCredential(), {
			name: "managed",
			access: "stored-access",
			refresh: "stored-refresh",
			expires: Date.now() + 60_000,
			source: "login",
		});
		const first = await resolveProviderAuth(provider, credentialStore(stored), authContext());
		if (!first?.auth.apiKey) throw new Error("expected stored OAuth auth");

		const replay = await resolveProviderAuth(provider, credentialStore(stored), authContext(), {
			apiKey: first.auth.apiKey,
		});

		expect(replay?.auth).toEqual(first.auth);
	});

	it("preserves replay-only credential env for configured headers", async () => {
		const provider = composedProvider(async () => true, {
			headers: { "X-Extra": "$EXTRA_HEADER_TOKEN" },
		});
		if (!provider.auth.apiKey) throw new Error("expected ambient adapter");
		const replay = await provider.auth.apiKey.resolve({
			ctx: authContext({ CLAUDE_CODE_OAUTH_TOKEN: "request-token" }),
			credential: {
				type: "api_key",
				key: SENTINEL_OAUTH_FIELDS.access,
				env: { EXTRA_HEADER_TOKEN: "credential-only" },
			},
			signal: new AbortController().signal,
		});

		expect(replay?.auth.headers?.["X-Extra"]).toBe("credential-only");
	});

	it("accepts request tokens in explicit ambient mode without a host probe", async () => {
		const readAmbientAuthStatus = vi.fn(async () => false);
		const provider = composedProvider(readAmbientAuthStatus, {
			oauth: createOAuthConfig({
				readAmbientAuthStatus,
				readCurrent: async () => undefined,
				readSettings: () => ({ tokenInjection: "ambient" }),
			}),
		});
		const requestEnvironment = { CLAUDE_CODE_OAUTH_TOKEN: "request-token" };

		const resolved = await resolveProviderAuth(provider, credentialStore(), authContext(), {
			env: requestEnvironment,
		});

		expect(resolved?.env).toEqual(requestEnvironment);
		expect(readAmbientAuthStatus).not.toHaveBeenCalled();
	});

	it("preserves an explicit empty token mask through ambient replay", async () => {
		const provider = composedProvider(async () => true);
		const hostEnvironment = { CLAUDE_CODE_OAUTH_TOKEN: "host-token" };
		const requestEnvironment = { CLAUDE_CODE_OAUTH_TOKEN: "" };
		const first = await resolveProviderAuth(provider, credentialStore(), authContext(hostEnvironment), {
			env: requestEnvironment,
		});
		if (!first?.auth.apiKey) throw new Error("expected ambient auth");

		const replay = await resolveProviderAuth(provider, credentialStore(), authContext(hostEnvironment), {
			apiKey: first.auth.apiKey,
			env: first.env,
		});

		expect(first.env).toEqual(requestEnvironment);
		expect(replay?.env).toEqual(requestEnvironment);
	});
});
