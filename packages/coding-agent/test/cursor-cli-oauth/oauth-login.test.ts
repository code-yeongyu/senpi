import { readFile } from "node:fs/promises";
import type {
	AuthContext,
	Credential,
	OAuthAuth,
	OAuthCredential,
	ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
	type CursorCliOauthCredential,
	emptyCredential,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/accounts.ts";
import {
	type CursorCliOauthConfig,
	createCursorCliOauthConfig,
	importLocalCursorCredential,
	resolveCursorCliOauthLane,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/oauth-login.ts";

const PROVIDER_ID = "cursor-cli-oauth";

function authContext(): AuthContext {
	return {
		env: async () => undefined,
		fileExists: async () => false,
	};
}

function account(name = "default", access = "access-token") {
	return {
		name,
		access,
		refresh: "refresh-token",
		expires: Date.now() + 60_000,
		source: "login" as const,
	};
}

function credential(accounts = [account()]): CursorCliOauthCredential {
	return { ...emptyCredential(), accounts };
}

function oauthFlow(overrides: Partial<OAuthAuth> = {}): OAuthAuth {
	return {
		name: "Cursor",
		login: async (_interaction: ProviderAuthInteraction): Promise<OAuthCredential> => ({
			type: "oauth",
			access: "logged-in-access",
			refresh: "logged-in-refresh",
			expires: Date.now() + 120_000,
		}),
		refresh: async (stored) => stored,
		toAuth: async (stored) => ({ apiKey: stored.access }),
		...overrides,
	};
}

function dependencies(current: () => Promise<CursorCliOauthCredential | undefined>) {
	return {
		readCurrent: current,
		readSettings: () => ({ enabled: true, executablePath: undefined }),
		resolveExecutable: () => "/usr/local/bin/cursor-agent",
		loadOAuth: async () => oauthFlow(),
	};
}

describe("cursor-cli-oauth login and availability", () => {
	it("uses one fresh-state predicate and always resolves the file-store lane", async () => {
		let stored = credential([account("default", "old-token")]);
		const deps = dependencies(async () => stored);
		const config = createCursorCliOauthConfig(deps);

		await expect(config.check({ ctx: authContext(), credential: stored })).resolves.toEqual({
			type: "oauth",
			source: "configured (file-store, 1 accounts)",
		});

		stored = credential([account("default", "fresh-token")]);
		const resolution = await resolveCursorCliOauthLane(deps);
		expect(resolution.lane).toBe("file-store");
		expect(resolution.account.access).toBe("fresh-token");
	});

	it("contains no alternate lane value in the implementation", async () => {
		const source = await readFile(
			new URL("../../src/core/extensions/builtin/cursor-cli-oauth/oauth-login.ts", import.meta.url),
			"utf8",
		);
		expect(source).not.toContain(`am${"bient"}`);
	});

	it("reports configured only for non-empty OAuth account slots", async () => {
		const config = createCursorCliOauthConfig(dependencies(async () => credential([account(), account("other")])));
		await expect(config.check({ ctx: authContext() })).resolves.toEqual({
			type: "oauth",
			source: "configured (file-store, 2 accounts)",
		});
	});

	it("check tolerates disabled by settings instead of throwing", async () => {
		const deps = {
			...dependencies(async () => credential()),
			readSettings: () => ({ enabled: false, explicitlyDisabled: true, executablePath: undefined }),
		};
		const config = createCursorCliOauthConfig(deps);
		await expect(config.check({ ctx: authContext() })).resolves.toBeUndefined();
	});

	it("check tolerates a missing cursor-agent executable instead of throwing", async () => {
		const deps = {
			...dependencies(async () => credential()),
			resolveExecutable: () => {
				throw new Error(
					"Cursor CLI is not installed. Install it with `curl https://cursor.com/install -fsS | bash`, then ensure ~/.local/bin is on your PATH.",
				);
			},
		};
		const config = createCursorCliOauthConfig(deps);
		await expect(config.check({ ctx: authContext() })).resolves.toBeUndefined();
	});

	it("check tolerates an empty or malformed provider credential instead of throwing", async () => {
		const emptyConfig = createCursorCliOauthConfig(dependencies(async () => emptyCredential()));
		await expect(emptyConfig.check({ ctx: authContext() })).resolves.toBeUndefined();

		const malformed: Credential = { type: "api_key", key: "not-oauth" };
		const malformedConfig = createCursorCliOauthConfig({
			...dependencies(async () => undefined),
			readCurrent: async () => malformed,
		});
		await expect(malformedConfig.check({ ctx: authContext() })).resolves.toBeUndefined();
	});

	it("does not count an account with an empty access token as configured", async () => {
		const config = createCursorCliOauthConfig(dependencies(async () => credential([account("default", "")])));
		await expect(config.check({ ctx: authContext() })).resolves.toBeUndefined();
	});

	it("check never reads a real Cursor credential source", async () => {
		const readCursorFile = vi.fn(async () => ({ access: "file", refresh: "file-refresh" }));
		const readCursorKeychain = vi.fn(async () => ({ access: "keychain", refresh: "keychain-refresh" }));
		const config = createCursorCliOauthConfig({
			...dependencies(async () => credential()),
			readCursorFile,
			readCursorKeychain,
		});

		await config.check({ ctx: authContext() });
		expect(readCursorFile).not.toHaveBeenCalled();
		expect(readCursorKeychain).not.toHaveBeenCalled();
	});

	it("names the first login default and prompts when a slot already exists", async () => {
		const login = vi.fn(oauthFlow().login);
		const prompt = vi.fn(async (ask: { message: string }) =>
			ask.message.includes("Name for this account") ? "work" : "yes",
		);
		const persist = vi.fn();
		const fixedNow = () => new Date(Date.parse("2026-08-17T12:00:00.000Z"));
		const callbacks = {
			onAuth: vi.fn(),
			onDeviceCode: vi.fn(),
			onPrompt: prompt,
			onSelect: vi.fn(async () => undefined),
		};
		const first = createCursorCliOauthConfig({
			...dependencies(async () => undefined),
			loadOAuth: async () => oauthFlow({ login }),
			now: fixedNow,
			persistAcknowledgement: persist,
		});

		const firstCredential = await first.login(callbacks);
		expect((firstCredential.accounts as Array<{ name: string }>)[0]?.name).toBe("default");
		// First login presents only the one-screen acknowledgement prompt.
		expect(prompt).toHaveBeenCalledTimes(1);

		const second = createCursorCliOauthConfig({
			...dependencies(async () => firstCredential as CursorCliOauthCredential),
			loadOAuth: async () => oauthFlow({ login }),
			now: fixedNow,
			persistAcknowledgement: persist,
		});
		const secondCredential = await second.login(callbacks);
		expect((secondCredential.accounts as Array<{ name: string }>).map((slot) => slot.name)).toEqual([
			"default",
			"work",
		]);
		// Second login: account-name prompt plus the acknowledgement prompt.
		expect(prompt).toHaveBeenCalledTimes(3);
		expect(login).toHaveBeenCalledTimes(2);
	});

	it("requests provider enablement after a successful login", async () => {
		const persistEnabled = vi.fn();
		const config = createCursorCliOauthConfig({
			...dependencies(async () => undefined),
			loadOAuth: async () => oauthFlow(),
			persistEnabled,
		});

		await config.login({
			onAuth: vi.fn(),
			onDeviceCode: vi.fn(),
			onPrompt: vi.fn(async () => "no"),
			onSelect: vi.fn(async () => undefined),
		});

		expect(persistEnabled).toHaveBeenCalledOnce();
		expect(persistEnabled).toHaveBeenCalledWith(true);
	});

	it("delegates expired slot refresh to the Cursor OAuth loader", async () => {
		const refresh = vi.fn(
			async (_stored: OAuthCredential, _signal: AbortSignal): Promise<OAuthCredential> => ({
				type: "oauth",
				access: "refreshed-access",
				refresh: "rotated-refresh",
				expires: Date.now() + 120_000,
			}),
		);
		const config = createCursorCliOauthConfig({
			...dependencies(async () => undefined),
			loadOAuth: async () => oauthFlow({ refresh }),
		});
		const expired = credential([{ ...account(), expires: 0 }]);
		const refreshed = (await config.refreshToken(expired, new AbortController().signal)) as CursorCliOauthCredential;

		expect(refresh).toHaveBeenCalledOnce();
		expect(refreshed.accounts?.[0]).toMatchObject({
			access: "refreshed-access",
			refresh: "rotated-refresh",
		});
	});

	it("explicit import copies a credential into a named slot with import source", async () => {
		const readCursorFile = vi.fn(async () => ({
			access: "copied-access",
			refresh: "copied-refresh",
			expires: 123_456,
		}));
		const imported = await importLocalCursorCredential(emptyCredential(), {
			platform: "linux",
			readCursorFile,
			readCursorKeychain: vi.fn(async () => undefined),
		});

		expect(imported.accounts).toEqual([
			{
				name: "default",
				access: "copied-access",
				refresh: "copied-refresh",
				expires: 123_456,
				source: "import",
			},
		]);
		expect(readCursorFile).toHaveBeenCalledOnce();
	});

	it("uses the provider sentinel as its API key", () => {
		const config = createCursorCliOauthConfig(dependencies(async () => credential()));
		expect(config.getApiKey(credential())).toBe(`${PROVIDER_ID}-managed`);
	});
});

const ACKNOWLEDGED_AT = "2026-08-17T12:34:56.000Z";

function loginCallbacks(answer: () => Promise<string>) {
	return {
		onAuth: vi.fn(),
		onDeviceCode: vi.fn(),
		onPrompt: vi.fn(async (_ask: { message: string }) => answer()),
		onSelect: vi.fn(async () => undefined),
	};
}

describe("cursor-cli-oauth no-approval acknowledgement at login", () => {
	const fixedNow = () => new Date(Date.parse(ACKNOWLEDGED_AT));

	function acknowledgementConfig(
		persist: ReturnType<typeof vi.fn>,
		current: () => Promise<CursorCliOauthCredential | undefined> = async () => undefined,
	) {
		return createCursorCliOauthConfig({
			...dependencies(current),
			loadOAuth: async () => oauthFlow(),
			now: fixedNow,
			persistAcknowledgement: persist as (acknowledgedAt: string) => void,
		});
	}

	it("presents the one-screen explanation exactly once and persists on explicit confirmation", async () => {
		const persist = vi.fn();
		const callbacks = loginCallbacks(async () => "yes");
		const config = acknowledgementConfig(persist);

		const stored = await config.login(callbacks);

		// Exactly one acknowledgement prompt, carrying the full explanation.
		const explanations = callbacks.onPrompt.mock.calls
			.map((call) => call[0])
			.filter((ask) => !ask.message.includes("Name for this account"));
		expect(explanations).toHaveLength(1);
		expect(explanations[0]?.message).toContain("no senpi approval");
		expect(explanations[0]?.message).toContain("no senpi sandboxing");
		expect(explanations[0]?.message).toContain("no tool-level audit");
		expect(explanations[0]?.message).toContain("executionMode");
		// Confirm means persist: acknowledged-but-unwritten must be impossible.
		expect(persist).toHaveBeenCalledTimes(1);
		expect(persist).toHaveBeenCalledWith(ACKNOWLEDGED_AT);
		// The slot is stored either way.
		expect((stored.accounts as Array<{ name: string }>).map((slot) => slot.name)).toEqual(["default"]);
	});

	it("still stores the slot on decline and writes no acknowledgement", async () => {
		const persist = vi.fn();
		const callbacks = loginCallbacks(async () => "no");
		const config = acknowledgementConfig(persist);

		const stored = await config.login(callbacks);

		expect(persist).not.toHaveBeenCalled();
		expect((stored.accounts as Array<{ name: string }>).map((slot) => slot.name)).toEqual(["default"]);
	});

	it("keeps the acknowledgement unwritten across repeated declined logins", async () => {
		const persist = vi.fn();
		let current: CursorCliOauthCredential | undefined;
		const config = acknowledgementConfig(persist, async () => current);

		current = (await config.login(loginCallbacks(async () => "no"))) as CursorCliOauthCredential;
		current = (await config.login(loginCallbacks(async () => ""))) as CursorCliOauthCredential;

		expect((current.accounts as Array<{ name: string }>).map((slot) => slot.name)).toEqual(["default", "account-2"]);
		expect(persist).not.toHaveBeenCalled();
	});

	it("skips the prompt and the write when no interaction surface exists", async () => {
		const persist = vi.fn();
		const config = acknowledgementConfig(persist);
		const callbacks = {
			onAuth: vi.fn(),
			onDeviceCode: vi.fn(),
			onSelect: vi.fn(async () => undefined),
		} as unknown as Parameters<CursorCliOauthConfig["login"]>[0];

		const stored = await config.login(callbacks);

		expect(persist).not.toHaveBeenCalled();
		expect((stored.accounts as Array<{ name: string }>).map((slot) => slot.name)).toEqual(["default"]);
	});
});
