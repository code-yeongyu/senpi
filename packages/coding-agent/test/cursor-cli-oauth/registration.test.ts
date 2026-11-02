import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AuthContext,
	type Credential,
	InMemoryCredentialStore,
	type OAuthCredential,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CursorCliOauthCredential,
	emptyCredential,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/accounts.ts";
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
		explicitlyDisabled: false,
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
	return captureRegistrationWithDeps(factory, missingExecutableDeps(store));
}

async function captureRegistrationWithDeps(
	factory: (pi: ExtensionAPI, deps: CursorCliOauthExtensionDeps) => void,
	deps: CursorCliOauthExtensionDeps,
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
	factory(pi, deps);
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

function nativeCredential(): OAuthCredential {
	return {
		type: "oauth",
		access: "native-access-token",
		refresh: "native-refresh-token",
		expires: Date.now() + 3_600_000,
	};
}

async function managedCredential(store: InMemoryCredentialStore): Promise<CursorCliOauthCredential | undefined> {
	const value = await store.read(CURSOR_CLI_OAUTH_PROVIDER_ID);
	return value?.type === "oauth" ? (value as CursorCliOauthCredential) : undefined;
}

function bootstrapDeps(
	store: InMemoryCredentialStore,
	overrides: Partial<CursorCliOauthExtensionDeps> & {
		readNativeCredential?: () => Credential | undefined | Promise<Credential | undefined>;
	} = {},
): CursorCliOauthExtensionDeps {
	return {
		cwd: temporaryDirectory(),
		store,
		loadSettings: () => enabledSettings(),
		resolveExecutable: () => "/qa/cursor-agent",
		...overrides,
	} as CursorCliOauthExtensionDeps;
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

describe("cursor-cli-oauth automatic native bootstrap", () => {
	it("imports one native account during the first configured auth check", async () => {
		const store = new InMemoryCredentialStore();
		const native = nativeCredential();
		await store.modify("cursor", async () => native);
		const nativeBefore = JSON.stringify(await store.read("cursor"));
		const registration = await captureRegistrationWithDeps(
			(pi, deps) => registerCursorCliOauthExtension(pi, deps),
			bootstrapDeps(store, { readNativeCredential: () => store.read("cursor") }),
		);
		const oauth = registration.config.oauth as {
			check: (input: { ctx: AuthContext }) => Promise<unknown>;
		};

		await expect(oauth.check({ ctx: authContext() })).resolves.toEqual({
			type: "oauth",
			source: "configured (file-store, 1 accounts)",
		});
		expect((await managedCredential(store))?.accounts).toMatchObject([
			{ name: "native", source: "import", access: native.access, refresh: native.refresh },
		]);
		expect(JSON.stringify(await store.read("cursor"))).toBe(nativeBefore);
	});

	it("does not read or copy native credentials when explicitly disabled", async () => {
		const store = new InMemoryCredentialStore();
		await store.modify("cursor", async () => nativeCredential());
		const readNativeCredential = vi.fn(() => store.read("cursor"));
		const registration = await captureRegistrationWithDeps(
			(pi, deps) => registerCursorCliOauthExtension(pi, deps),
			bootstrapDeps(store, {
				loadSettings: () => ({ ...enabledSettings(), enabled: false, explicitlyDisabled: true }),
				readNativeCredential,
			}),
		);
		const oauth = registration.config.oauth as {
			check: (input: { ctx: AuthContext }) => Promise<unknown>;
		};

		await expect(oauth.check({ ctx: authContext() })).resolves.toBeUndefined();
		expect(readNativeCredential).not.toHaveBeenCalled();
		expect(await store.read(CURSOR_CLI_OAUTH_PROVIDER_ID)).toBeUndefined();
	});

	it("does not read or copy native credentials when cursor-agent is missing", async () => {
		const store = new InMemoryCredentialStore();
		await store.modify("cursor", async () => nativeCredential());
		const readNativeCredential = vi.fn(() => store.read("cursor"));
		const registration = await captureRegistrationWithDeps(
			(pi, deps) => registerCursorCliOauthExtension(pi, deps),
			bootstrapDeps(store, {
				readNativeCredential,
				resolveExecutable: () => {
					throw new CursorAgentNotInstalledError();
				},
			}),
		);
		const oauth = registration.config.oauth as {
			check: (input: { ctx: AuthContext }) => Promise<unknown>;
		};

		await expect(oauth.check({ ctx: authContext() })).resolves.toBeUndefined();
		expect(readNativeCredential).not.toHaveBeenCalled();
		expect(await store.read(CURSOR_CLI_OAUTH_PROVIDER_ID)).toBeUndefined();
	});

	it("preserves existing managed accounts without reading the native credential", async () => {
		const store = await storeWithAccount();
		await store.modify("cursor", async () => nativeCredential());
		const readNativeCredential = vi.fn(() => store.read("cursor"));
		const before = JSON.stringify(await store.read(CURSOR_CLI_OAUTH_PROVIDER_ID));
		const registration = await captureRegistrationWithDeps(
			(pi, deps) => registerCursorCliOauthExtension(pi, deps),
			bootstrapDeps(store, { readNativeCredential }),
		);
		const oauth = registration.config.oauth as {
			check: (input: { ctx: AuthContext }) => Promise<unknown>;
		};

		await expect(oauth.check({ ctx: authContext() })).resolves.toEqual({
			type: "oauth",
			source: "configured (file-store, 1 accounts)",
		});
		expect(readNativeCredential).not.toHaveBeenCalled();
		expect(JSON.stringify(await store.read(CURSOR_CLI_OAUTH_PROVIDER_ID))).toBe(before);
	});

	it("deduplicates concurrent checks and repeated startup reads", async () => {
		const store = new InMemoryCredentialStore();
		await store.modify("cursor", async () => nativeCredential());
		const readNativeCredential = vi.fn(() => store.read("cursor"));
		const registration = await captureRegistrationWithDeps(
			(pi, deps) => registerCursorCliOauthExtension(pi, deps),
			bootstrapDeps(store, { readNativeCredential }),
		);
		const oauth = registration.config.oauth as {
			check: (input: { ctx: AuthContext }) => Promise<unknown>;
		};

		await Promise.all([
			oauth.check({ ctx: authContext() }),
			oauth.check({ ctx: authContext() }),
			oauth.check({ ctx: authContext() }),
		]);
		await oauth.check({ ctx: authContext() });

		expect((await managedCredential(store))?.accounts?.map((account) => account.name)).toEqual(["native"]);
		expect(readNativeCredential).toHaveBeenCalledOnce();
	});

	it("keeps auth checks non-throwing when native bootstrap fails", async () => {
		const store = new InMemoryCredentialStore();
		const registration = await captureRegistrationWithDeps(
			(pi, deps) => registerCursorCliOauthExtension(pi, deps),
			bootstrapDeps(store, {
				readNativeCredential: async () => {
					throw new Error("native store unavailable");
				},
			}),
		);
		const oauth = registration.config.oauth as {
			check: (input: { ctx: AuthContext }) => Promise<unknown>;
		};

		await expect(oauth.check({ ctx: authContext() })).resolves.toBeUndefined();
		expect(await store.read(CURSOR_CLI_OAUTH_PROVIDER_ID)).toBeUndefined();
	});
});
