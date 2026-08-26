import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthContext, Credential } from "@earendil-works/pi-ai";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CursorCliOauthCredential,
	emptyCredential,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/accounts.ts";
import {
	CURSOR_CLI_OAUTH_PROVIDER_ID,
	registerCursorCliOauthExtension,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/index.ts";
import {
	type CursorCliOauthConfigDeps,
	createCursorCliOauthConfig,
	resolveCursorCliOauthLane,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/oauth-login.ts";
import {
	type CursorCliOauthProviderSettings,
	loadCursorCliOauthProviderSettingsFromDisk,
	parseCursorCliOauthProviderSettings,
	persistCursorCliOauthEnabled,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/settings.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import type { ProviderConfigInput } from "../../src/core/provider-composer.ts";

/**
 * Ambient opt-in contract (senpi): a logged-in host `cursor-agent` is NOT
 * senpi-side consent. The `cursorCliOauthProvider.enabled` flag gates only the
 * AMBIENT lane - the host-CLI-derived native credential bootstrap. An explicit
 * senpi-side login (stored account slots in the credential store) is itself the
 * opt-in and keeps the lane available with the flag unset.
 */

const temporaryDirectories: string[] = [];
const originalAgentDir = process.env.SENPI_CODING_AGENT_DIR;

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "senpi-cursor-cli-optin-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.SENPI_CODING_AGENT_DIR;
	else process.env.SENPI_CODING_AGENT_DIR = originalAgentDir;
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function authContext(): AuthContext {
	return {
		env: async () => undefined,
		fileExists: async () => false,
	};
}

function account(name = "default") {
	return {
		name,
		access: "access-token",
		refresh: "refresh-token",
		expires: Date.now() + 60_000,
		source: "login" as const,
	};
}

function credential(accounts = [account()]): CursorCliOauthCredential {
	return { ...emptyCredential(), accounts };
}

function providerSettings(overrides: Partial<CursorCliOauthProviderSettings> = {}): CursorCliOauthProviderSettings {
	return { ...parseCursorCliOauthProviderSettings(undefined, {}), ...overrides };
}

/** The ambient shape from the reported machine: cursor-agent installed and logged in, nothing stored in senpi. */
function ambientDeps(overrides: Partial<CursorCliOauthConfigDeps> = {}): CursorCliOauthConfigDeps {
	return {
		readCurrent: async () => undefined,
		readSettings: () => providerSettings(),
		resolveExecutable: () => "/usr/local/bin/cursor-agent",
		...overrides,
	};
}

function nativeCredential(): Credential {
	return {
		type: "oauth",
		access: "native-access-token",
		refresh: "native-refresh-token",
		expires: Date.now() + 3_600_000,
	};
}

function writeGlobalSettings(agentDir: string, provider: Record<string, unknown>): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cursorCliOauthProvider: provider }, null, 2));
}

describe("cursor-cli-oauth ambient opt-in", () => {
	it("defaults enabled to false so an ambient cursor-agent login is not senpi-side consent", () => {
		expect(parseCursorCliOauthProviderSettings(undefined, {}).enabled).toBe(false);
		expect(parseCursorCliOauthProviderSettings({}, {}).enabled).toBe(false);
	});

	it("hides the lane while the flag is unset, even with a resolvable executable", async () => {
		const config = createCursorCliOauthConfig(ambientDeps());

		await expect(config.check({ ctx: authContext() })).resolves.toBeUndefined();
		await expect(resolveCursorCliOauthLane(ambientDeps())).rejects.toThrow("disabled by settings");
	});

	it("does not bootstrap the host native credential while the flag is unset", async () => {
		const store = new InMemoryCredentialStore();
		await store.modify("cursor", async () => nativeCredential());
		const readNativeCredential = vi.fn(() => store.read("cursor"));
		let captured: { name: string; config: ProviderConfigInput } | undefined;
		const pi = {
			registerProvider: (name: string, config: ProviderConfigInput) => {
				captured = { name, config };
			},
			registerCommand: () => {},
			registerFlag: () => {},
			getFlag: () => undefined,
			on: () => {},
		} as unknown as ExtensionAPI;

		registerCursorCliOauthExtension(pi, {
			cwd: temporaryDirectory(),
			store,
			readNativeCredential,
			loadSettings: () => providerSettings(),
			resolveExecutable: () => "/qa/cursor-agent",
		});
		const oauth = captured?.config.oauth as {
			check: (input: { ctx: AuthContext }) => Promise<unknown>;
		};

		await expect(oauth.check({ ctx: authContext() })).resolves.toBeUndefined();
		expect(readNativeCredential).not.toHaveBeenCalled();
		expect(await store.read(CURSOR_CLI_OAUTH_PROVIDER_ID)).toBeUndefined();
	});

	it("exposes the lane once the setting opts in", async () => {
		const config = createCursorCliOauthConfig(
			ambientDeps({
				readCurrent: async () => credential(),
				readSettings: () => providerSettings({ enabled: true }),
			}),
		);

		await expect(config.check({ ctx: authContext() })).resolves.toEqual({
			type: "oauth",
			source: "configured (file-store, 1 accounts)",
		});
	});

	it("honours SENPI_CURSOR_CLI_OAUTH_ENABLED over an absent settings value", async () => {
		const agentDir = temporaryDirectory();
		const cwd = temporaryDirectory();
		process.env.SENPI_CODING_AGENT_DIR = agentDir;
		writeGlobalSettings(agentDir, { pinnedAccount: "work" });

		expect(parseCursorCliOauthProviderSettings({}, { SENPI_CURSOR_CLI_OAUTH_ENABLED: "1" }).enabled).toBe(true);
		vi.stubEnv("SENPI_CURSOR_CLI_OAUTH_ENABLED", "1");
		const fromDisk = loadCursorCliOauthProviderSettingsFromDisk(cwd);
		expect(fromDisk.enabled).toBe(true);

		const config = createCursorCliOauthConfig(
			ambientDeps({ readCurrent: async () => credential(), readSettings: () => fromDisk }),
		);
		await expect(config.check({ ctx: authContext() })).resolves.toEqual({
			type: "oauth",
			source: "configured (file-store, 1 accounts)",
		});
		vi.unstubAllEnvs();
	});

	it("turns the lane on through the login/import persistence path", () => {
		const agentDir = temporaryDirectory();
		const cwd = temporaryDirectory();
		process.env.SENPI_CODING_AGENT_DIR = agentDir;
		mkdirSync(agentDir, { recursive: true });

		expect(loadCursorCliOauthProviderSettingsFromDisk(cwd).enabled).toBe(false);
		persistCursorCliOauthEnabled(cwd, true);

		const afterLogin = loadCursorCliOauthProviderSettingsFromDisk(cwd);
		expect(afterLogin.enabled).toBe(true);
		expect(afterLogin.explicitlyDisabled).toBe(false);
	});

	it("keeps an explicit senpi-side login available while the flag is unset", async () => {
		const deps = ambientDeps({ readCurrent: async () => credential([account(), account("work")]) });
		const config = createCursorCliOauthConfig(deps);

		await expect(config.check({ ctx: authContext() })).resolves.toEqual({
			type: "oauth",
			source: "configured (file-store, 2 accounts)",
		});
		await expect(resolveCursorCliOauthLane(deps)).resolves.toMatchObject({ lane: "file-store" });
	});

	it("keeps an explicit settings opt-out authoritative over stored accounts", async () => {
		// `enabled: false` written verbatim is the kill switch; an absent flag is not.
		const optedOut = parseCursorCliOauthProviderSettings({ enabled: false }, {});
		expect(optedOut.explicitlyDisabled).toBe(true);
		expect(parseCursorCliOauthProviderSettings({}, { SENPI_CURSOR_CLI_OAUTH_ENABLED: "0" }).explicitlyDisabled).toBe(
			true,
		);
		expect(parseCursorCliOauthProviderSettings(undefined, {}).explicitlyDisabled).toBe(false);
		const deps = ambientDeps({
			readCurrent: async () => credential(),
			readSettings: () => optedOut,
		});

		await expect(createCursorCliOauthConfig(deps).check({ ctx: authContext() })).resolves.toBeUndefined();
		await expect(resolveCursorCliOauthLane(deps)).rejects.toThrow("disabled by settings");
	});
});
