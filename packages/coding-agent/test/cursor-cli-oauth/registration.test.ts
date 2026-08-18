import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthContext, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { emptyCredential } from "../../src/core/extensions/builtin/cursor-cli-oauth/accounts.ts";
import { CursorAgentNotInstalledError } from "../../src/core/extensions/builtin/cursor-cli-oauth/executable.ts";
import cursorCliOauthExtension, {
	CURSOR_CLI_OAUTH_PROVIDER_ID,
	type CursorCliOauthExtensionDeps,
	registerCursorCliOauthExtension,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/index.ts";
import { STATIC_CURSOR_CLI_MODELS } from "../../src/core/extensions/builtin/cursor-cli-oauth/models.ts";
import type { CursorCliOauthProviderSettings } from "../../src/core/extensions/builtin/cursor-cli-oauth/settings.ts";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import type { ProviderConfigInput } from "../../src/core/provider-composer.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "../../src/core/provider-display-names.ts";

type Registration = { name: string; config: ProviderConfigInput };

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "cursor-cli-registration-"));
	temporaryDirectories.push(directory);
	return directory;
}

/** Resolution fails exactly as a machine without cursor-agent installed would. */
function missingExecutableDeps(store: InMemoryCredentialStore): CursorCliOauthExtensionDeps {
	return {
		cwd: temporaryDirectory(),
		store,
		loadSettings: () => enabledSettings(),
		resolveExecutable: () => {
			throw new CursorAgentNotInstalledError();
		},
	};
}

function enabledSettings(): CursorCliOauthProviderSettings {
	return {
		enabled: true,
		executablePath: undefined,
		forceExecution: true,
		noApprovalAcknowledgedAt: undefined,
		executionMode: "agent",
		resumeMode: "auto",
		pinnedAccount: undefined,
		contextRecapOnModelSwitch: true,
		modelCatalogTtlHours: 24,
		sandboxMode: undefined,
	};
}

async function captureRegistration(
	factory: (pi: ExtensionAPI, deps: CursorCliOauthExtensionDeps) => void,
	store: InMemoryCredentialStore,
): Promise<Registration> {
	let captured: Registration | undefined;
	const pi = {
		registerProvider: (name: string, config: ProviderConfigInput) => {
			captured = { name, config };
		},
		registerCommand: () => {},
		registerFlag: () => {},
		getFlag: () => undefined,
		on: () => {},
	} as unknown as ExtensionAPI;
	factory(pi, missingExecutableDeps(store));
	if (!captured) throw new Error("extension did not register a provider");
	return captured;
}

async function storeWithAccount(): Promise<InMemoryCredentialStore> {
	const store = new InMemoryCredentialStore();
	await store.modify(CURSOR_CLI_OAUTH_PROVIDER_ID, async () => ({
		...emptyCredential(),
		accounts: [
			{
				name: "default",
				access: "access-token",
				refresh: "refresh-token",
				expires: Date.now() + 3_600_000,
				source: "login",
			},
		],
	}));
	return store;
}

function authContext(): AuthContext {
	return {
		env: async () => undefined,
		fileExists: async () => false,
	};
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("cursor-cli-oauth provider registration", () => {
	it("registers the provider, stream, oauth config, and display name while the executable is missing", async () => {
		const registration = await captureRegistration(
			(pi, deps) => registerCursorCliOauthExtension(pi, deps),
			await storeWithAccount(),
		);

		expect(registration.name).toBe("cursor-cli-oauth");
		expect(CURSOR_CLI_OAUTH_PROVIDER_ID).toBe("cursor-cli-oauth");
		expect(registration.config.baseUrl).toBe("cursor-cli-oauth");
		expect(registration.config.api).toBe("cursor-cli-oauth");
		expect(typeof registration.config.streamSimple).toBe("function");
		// The offline fallback ships immediately; the probe-backed catalog replaces it later.
		expect(registration.config.models?.map((entry) => entry.id)).toEqual(
			STATIC_CURSOR_CLI_MODELS.map((entry) => entry.id),
		);
		expect(registration.config.oauth?.name).toBe("Cursor CLI (OAuth)");
		expect(BUILT_IN_PROVIDER_DISPLAY_NAMES["cursor-cli-oauth"]).toBe("Cursor CLI (OAuth)");
	});

	it("is wired into the builtin extension list with the default export", async () => {
		const entry = builtinExtensions.find((extension) => extension.id === "cursor-cli-oauth");
		expect(entry).toBeDefined();
		expect(typeof entry?.factory).toBe("function");

		const registration = await captureRegistration((pi) => cursorCliOauthExtension(pi), await storeWithAccount());
		expect(registration.name).toBe("cursor-cli-oauth");
	});

	it("tolerates the missing executable in the oauth check without breaking registration", async () => {
		const store = await storeWithAccount();
		const registration = await captureRegistration((pi, deps) => registerCursorCliOauthExtension(pi, deps), store);
		const oauth = registration.config.oauth as {
			name: string;
			check: (input: { ctx: AuthContext; credential?: unknown; signal?: AbortSignal }) => Promise<unknown>;
		};

		// Non-throwing by contract: ModelsImpl.getAvailable runs every provider's
		// check under Promise.all, so an unusable lane resolves undefined instead of
		// rejecting all model listing; turn-time resolution still throws the guidance.
		await expect(oauth.check({ ctx: authContext() })).resolves.toBeUndefined();
	});
});
