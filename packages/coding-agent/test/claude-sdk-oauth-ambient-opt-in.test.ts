import { describe, expect, it, vi } from "vitest";
import { resolveProviderAuth } from "../../ai/src/auth/resolve.ts";
import {
	addAccount,
	emptyCredential,
	SENTINEL_OAUTH_FIELDS,
} from "../src/core/extensions/builtin/claude-sdk-oauth/accounts.ts";
import { createOAuthConfig } from "../src/core/extensions/builtin/claude-sdk-oauth/oauth-login.ts";
import {
	type ClaudeSdkOauthProviderSettings,
	loadClaudeSdkOauthProviderSettings,
} from "../src/core/extensions/builtin/claude-sdk-oauth/settings.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { authContext, composedProvider, credentialStore } from "./support/claude-sdk-oauth-provider.ts";

const AUTH_CHECK = { source: "Claude SDK OAuth", type: "oauth" };

function optInProvider(readAmbientAuthStatus: () => Promise<boolean>, settings: ClaudeSdkOauthProviderSettings) {
	return composedProvider(readAmbientAuthStatus, {
		oauth: createOAuthConfig({
			readAmbientAuthStatus,
			readCurrent: async () => undefined,
			readSettings: () => settings,
		}),
	});
}

function settingsManager(global: unknown = {}, project: unknown = {}): SettingsManager {
	const storage = new InMemorySettingsStorage();
	storage.withLock("global", () => JSON.stringify({ claudeSdkOauthProvider: global }));
	storage.withLock("project", () => JSON.stringify({ claudeSdkOauthProvider: project }));
	return SettingsManager.fromStorage(storage);
}

describe("claude-sdk-oauth ambient opt-in", () => {
	it("hides an authenticated ambient CLI from check and resolveAmbient while the flag is unset", async () => {
		const readAmbientAuthStatus = vi.fn(async () => true);
		const config = createOAuthConfig({ readAmbientAuthStatus, readCurrent: async () => undefined });

		expect(await config.check({ ctx: authContext() })).toBeUndefined();
		expect(await config.resolveAmbient({ ctx: authContext() })).toBeUndefined();
	});

	it("exposes an authenticated ambient CLI once the setting opts in", async () => {
		const config = createOAuthConfig({
			readAmbientAuthStatus: async () => true,
			readCurrent: async () => undefined,
			readSettings: () => ({ enabled: true }),
		});

		expect(await config.check({ ctx: authContext() })).toEqual(AUTH_CHECK);
		expect((await config.resolveAmbient({ ctx: authContext() }))?.auth.apiKey).toBe(SENTINEL_OAUTH_FIELDS.access);
	});

	it("resolves ambient request auth through the composed provider when opted in", async () => {
		const provider = optInProvider(async () => true, { enabled: true });

		const resolved = await resolveProviderAuth(provider, credentialStore(), authContext());

		expect(resolved?.auth.apiKey).toBe(SENTINEL_OAUTH_FIELDS.access);
	});

	it("honours SENPI_CLAUDE_SDK_OAUTH_ENABLED over a disabling settings file", async () => {
		const manager = settingsManager({ enabled: false }, { enabled: false });
		const settings = loadClaudeSdkOauthProviderSettings(manager, { SENPI_CLAUDE_SDK_OAUTH_ENABLED: "TRUE" });
		const config = createOAuthConfig({
			readAmbientAuthStatus: async () => true,
			readCurrent: async () => undefined,
			readSettings: () => settings,
		});

		expect(settings.enabled).toBe(true);
		expect(await config.check({ ctx: authContext() })).toEqual(AUTH_CHECK);
	});

	it("defaults enabled to unset (false) and lets a settings value survive an absent env var", async () => {
		expect(loadClaudeSdkOauthProviderSettings(settingsManager(), {}).enabled).toBeUndefined();
		expect(loadClaudeSdkOauthProviderSettings(settingsManager({ enabled: true }), {}).enabled).toBe(true);
		expect(
			loadClaudeSdkOauthProviderSettings(settingsManager({ enabled: true }), {
				SENPI_CLAUDE_SDK_OAUTH_ENABLED: "0",
			}).enabled,
		).toBe(false);
	});

	it("keeps a stored account available while the flag is unset", async () => {
		const readAmbientAuthStatus = vi.fn(async () => false);
		const config = createOAuthConfig({ readAmbientAuthStatus, readCurrent: async () => undefined });
		const credential = addAccount(emptyCredential(), {
			name: "managed",
			access: "stored-access",
			refresh: "stored-refresh",
			expires: Date.now() + 60_000,
			source: "login",
		});

		expect(await config.check({ ctx: authContext(), credential })).toEqual(AUTH_CHECK);
		expect(readAmbientAuthStatus).not.toHaveBeenCalled();
	});

	it("keeps a CLAUDE_CODE_OAUTH_TOKEN env account available while the flag is unset", async () => {
		const readAmbientAuthStatus = vi.fn(async () => false);
		const config = createOAuthConfig({ readAmbientAuthStatus, readCurrent: async () => undefined });
		const ctx = authContext({ CLAUDE_CODE_OAUTH_TOKEN: "env-token" });

		expect(await config.check({ ctx })).toEqual(AUTH_CHECK);
		expect((await config.resolveAmbient({ ctx }))?.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "env-token" });
		expect(readAmbientAuthStatus).not.toHaveBeenCalled();
	});

	it("keeps an env token available even when the explicit ambient lane is selected without the flag", async () => {
		const readAmbientAuthStatus = vi.fn(async () => false);
		const config = createOAuthConfig({
			readAmbientAuthStatus,
			readCurrent: async () => undefined,
			readSettings: () => ({ tokenInjection: "ambient", enabled: false }),
		});
		const ctx = authContext({ CLAUDE_CODE_OAUTH_TOKEN: "env-token" });

		expect(await config.check({ ctx })).toEqual(AUTH_CHECK);
		expect(readAmbientAuthStatus).not.toHaveBeenCalled();
	});
});
