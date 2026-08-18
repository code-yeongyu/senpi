import type { Credential } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { subscribeProviderAccountEvents } from "../../src/core/extensions/builtin/claude-sdk-oauth/account-events.ts";
import {
	type CursorCliAccountCommandDeps,
	registerCursorCliAccountCommand,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/account-command.ts";
import {
	addAccount,
	type CursorCliAccountSlot,
	type CursorCliOauthCredential,
	emptyCredential,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/accounts.ts";
import {
	CURSOR_CLI_MINIMUM_KNOWN_GOOD_VERSION,
	CursorCliGenerationGuard,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/diagnostics.ts";
import type { importLocalCursorCredential } from "../../src/core/extensions/builtin/cursor-cli-oauth/oauth-login.ts";
import { CursorCliSessionRouter } from "../../src/core/extensions/builtin/cursor-cli-oauth/session-router.ts";
import type { CursorCliOauthProviderSettings } from "../../src/core/extensions/builtin/cursor-cli-oauth/settings.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../../src/core/extensions/types.ts";

const PROVIDER_ID = "cursor-cli-oauth";

type Command = Pick<RegisteredCommand, "handler">;
type SessionHandler = (event: unknown, ctx: ExtensionCommandContext) => Promise<void> | void;
type Notice = { message: string; type: "info" | "warning" | "error" | undefined };

const FIXED_NOW = Date.parse("2026-08-17T12:00:00.000Z");

function slot(name: string, extra: Partial<CursorCliAccountSlot> = {}): CursorCliAccountSlot {
	return {
		name,
		access: `SECRET-ACCESS-${name}-eyJhbGciOiJIUzI1NiJ9`,
		refresh: `SECRET-REFRESH-${name}-eyJhbGciOiJIUzI1NiJ9`,
		expires: FIXED_NOW + 3_600_000,
		source: "login",
		...extra,
	};
}

function credential(...accounts: CursorCliAccountSlot[]): CursorCliOauthCredential {
	return accounts.reduce((current, account) => addAccount(current, account), emptyCredential());
}

function asCredential(value: Credential | undefined): CursorCliOauthCredential {
	return value !== undefined && value.type === "oauth" ? (value as CursorCliOauthCredential) : emptyCredential();
}

function defaultSettings(overrides: Partial<CursorCliOauthProviderSettings> = {}): CursorCliOauthProviderSettings {
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
		...overrides,
	};
}

function createHarness(deps: CursorCliAccountCommandDeps = {}): {
	commands: Map<string, Command>;
	handlers: Map<string, SessionHandler>;
	generation: CursorCliGenerationGuard;
} {
	const commands = new Map<string, Command>();
	const handlers = new Map<string, SessionHandler>();
	const pi = {
		registerCommand: (name: string, command: Command) => commands.set(name, command),
		on: (event: string, handler: SessionHandler) => handlers.set(event, handler),
	} as unknown as ExtensionAPI;
	const generation = deps.generation ?? new CursorCliGenerationGuard();
	registerCursorCliAccountCommand(pi, { ...deps, generation });
	return { commands, handlers, generation };
}

function createContext(
	storage: AuthStorage,
	sessionId = "session-01",
	extra: { hasUI?: boolean; login?: () => Promise<void>; input?: (title: string) => Promise<string | undefined> } = {},
): {
	ctx: ExtensionCommandContext;
	notices: Notice[];
	login: ReturnType<typeof vi.fn>;
	refresh: ReturnType<typeof vi.fn>;
} {
	const notices: Notice[] = [];
	const login = vi.fn(extra.login ?? (async () => {}));
	const refresh = vi.fn(async () => ({ aborted: false, errors: new Map() }));
	return {
		ctx: {
			hasUI: extra.hasUI ?? true,
			cwd: "/tmp/cursor-account-command",
			signal: undefined,
			isIdle: () => true,
			sessionManager: { getSessionId: () => sessionId },
			modelRegistry: {
				authStorage: storage,
				modelRuntime: { login, refresh },
			},
			ui: {
				notify: (message: string, type?: Notice["type"]) => notices.push({ message, type }),
				input: extra.input ?? (async (title: string) => `${title}-answer`),
			},
		} as unknown as ExtensionCommandContext,
		notices,
		login,
		refresh,
	};
}

function command(harness: { commands: Map<string, Command> }): Command {
	const registered = harness.commands.get("cursor-account");
	if (!registered) throw new Error("/cursor-account was not registered");
	return registered;
}

function lastNotice(notices: Notice[]): string {
	return notices.at(-1)?.message ?? "";
}

describe("/cursor-account", () => {
	it("registers the command and a session_shutdown handler that retires the generation", async () => {
		const harness = createHarness();
		expect(harness.commands.has("cursor-account")).toBe(true);
		const shutdown = harness.handlers.get("session_shutdown");
		expect(shutdown).toBeDefined();

		const storage = AuthStorage.inMemory();
		const { ctx } = createContext(storage);
		await shutdown?.({ type: "session_shutdown", reason: "reload" }, ctx);

		expect(harness.generation.isRetired()).toBe(true);
	});

	it("lists account names, sources, block state, and picks without rendering token material", async () => {
		const storage = AuthStorage.inMemory({
			[PROVIDER_ID]: credential(
				slot("alpha"),
				{
					...slot("bravo", { source: "import" }),
					blockedUntil: FIXED_NOW + 60_000,
					blockReason: "rate_limit",
				},
				{ ...slot("backup"), blockReason: "auth_error" },
			),
		});
		const { ctx, notices } = createContext(storage);
		const harness = createHarness({
			loadSettings: () => defaultSettings({ pinnedAccount: "alpha" }),
			now: () => FIXED_NOW,
		});

		await command(harness).handler("list", ctx);

		const output = lastNotice(notices);
		expect(output).toContain("alpha | login | available | pinned | affinity pick");
		expect(output).toContain("bravo | import | blocked until");
		expect(output).toContain("backup | login | blocked until re-login");
		expect(output).toContain("Pinned account: alpha (settings)");
		expect(output).not.toContain("SECRET-ACCESS");
		expect(output).not.toContain("SECRET-REFRESH");
		expect(output).not.toContain("eyJhbGciOiJIUzI1NiJ9");
	});

	it("re-reads the store on every invocation instead of memoizing the account list", async () => {
		const storage = AuthStorage.inMemory({ [PROVIDER_ID]: credential(slot("alpha")) });
		const { ctx, notices } = createContext(storage);
		const harness = createHarness();

		await command(harness).handler("", ctx);
		expect(lastNotice(notices)).not.toContain("bravo");

		await storage.modify(PROVIDER_ID, async (current) => addAccount(asCredential(current), slot("bravo")));
		await command(harness).handler("list", ctx);

		expect(lastNotice(notices)).toContain("bravo");
	});

	it("persists pin and unpin round-trips and emits accounts_changed", async () => {
		const events: unknown[] = [];
		const unsubscribe = subscribeProviderAccountEvents((event) => events.push(event));
		try {
			const storage = AuthStorage.inMemory({ [PROVIDER_ID]: credential(slot("alpha"), slot("bravo")) });
			const { ctx, notices } = createContext(storage);
			const harness = createHarness();

			await command(harness).handler("pin bravo", ctx);
			expect(asCredential(storage.get(PROVIDER_ID)).pinned).toBe("bravo");
			expect(lastNotice(notices)).toContain("bravo");
			expect(events).toContainEqual({ type: "accounts_changed", provider: PROVIDER_ID });

			await command(harness).handler("list", ctx);
			expect(lastNotice(notices)).toContain("bravo | login | available | pinned");

			await command(harness).handler("unpin", ctx);
			expect(asCredential(storage.get(PROVIDER_ID)).pinned).toBeUndefined();
			expect(events.filter((event) => (event as { type: string }).type === "accounts_changed")).toHaveLength(2);
		} finally {
			unsubscribe();
		}
	});

	it("removes an account and clears its pin in one round-trip", async () => {
		const storage = AuthStorage.inMemory({ [PROVIDER_ID]: credential(slot("alpha"), slot("bravo")) });
		const { ctx, notices } = createContext(storage);
		const harness = createHarness();

		await command(harness).handler("pin alpha", ctx);
		await command(harness).handler("remove alpha", ctx);

		const stored = asCredential(storage.get(PROVIDER_ID));
		expect((stored.accounts ?? []).map((account) => account.name)).toEqual(["bravo"]);
		expect(stored.pinned).toBeUndefined();
		expect(lastNotice(notices)).toContain("alpha");
	});

	it("reports unknown accounts without mutating the store", async () => {
		const storage = AuthStorage.inMemory({ [PROVIDER_ID]: credential(slot("alpha")) });
		const { ctx, notices } = createContext(storage);
		const harness = createHarness();
		const before = JSON.stringify(storage.get(PROVIDER_ID));

		await command(harness).handler("remove missing", ctx);
		await command(harness).handler("pin missing", ctx);

		expect(JSON.stringify(storage.get(PROVIDER_ID))).toBe(before);
		expect(notices.filter((notice) => notice.type === "error")).toHaveLength(2);
	});

	it("prints usage for an unknown subcommand", async () => {
		const storage = AuthStorage.inMemory();
		const { ctx, notices } = createContext(storage);
		const harness = createHarness();

		await command(harness).handler("explode", ctx);

		expect(lastNotice(notices)).toContain("Usage: /cursor-account");
		expect(notices.at(-1)?.type).toBe("error");
	});

	it("adds an account through the provider OAuth login flow", async () => {
		const storage = AuthStorage.inMemory({ [PROVIDER_ID]: credential(slot("alpha")) });
		const { ctx, login, notices } = createContext(storage);
		const harness = createHarness();

		await command(harness).handler("add", ctx);

		expect(login).toHaveBeenCalledWith(
			PROVIDER_ID,
			"oauth",
			expect.objectContaining({ prompt: expect.any(Function) }),
		);
		expect(lastNotice(notices)).toContain("added");
	});

	it("refuses add without an interactive UI", async () => {
		const storage = AuthStorage.inMemory();
		const { ctx, login, notices } = createContext(storage, "session-01", { hasUI: false });
		const harness = createHarness();

		await command(harness).handler("add", ctx);

		expect(login).not.toHaveBeenCalled();
		expect(notices.at(-1)?.type).toBe("error");
	});

	it("invokes the local-credential import function and stores the copied slot", async () => {
		const storage = AuthStorage.inMemory({ [PROVIDER_ID]: credential(slot("alpha")) });
		const { ctx, notices, refresh } = createContext(storage);
		const importCredential = vi.fn<typeof importLocalCursorCredential>(async (current) =>
			addAccount(current, slot("imported", { source: "import" })),
		);
		const persistEnabled = vi.fn();
		const harness = createHarness({ importCredential, persistEnabled });

		await command(harness).handler("import", ctx);

		expect(importCredential).toHaveBeenCalledTimes(1);
		expect(asCredential(importCredential.mock.calls[0]?.[0]).accounts?.map((a) => a.name)).toEqual(["alpha"]);
		expect((asCredential(storage.get(PROVIDER_ID)).accounts ?? []).map((a) => a.name)).toEqual(["alpha", "imported"]);
		expect(persistEnabled).toHaveBeenCalledWith("/tmp/cursor-account-command", true);
		expect(refresh).toHaveBeenCalledWith({ allowNetwork: false, providers: [PROVIDER_ID] });
		expect(lastNotice(notices)).toContain("imported");
	});

	it("imports the native cursor credential without modifying the primary provider", async () => {
		const nativeCredential: Credential = {
			type: "oauth",
			access: "native-access-token",
			refresh: "native-refresh-token",
			expires: FIXED_NOW + 3_600_000,
		};
		const storage = AuthStorage.inMemory({ cursor: nativeCredential });
		const nativeBefore = JSON.stringify(storage.get("cursor"));
		const { ctx, notices, refresh } = createContext(storage);
		const persistEnabled = vi.fn();
		const harness = createHarness({
			importDeps: {
				platform: "linux",
				readCursorFile: async () => undefined,
				readCursorKeychain: async () => undefined,
			},
			persistEnabled,
			readNativeCredential: () => storage.get("cursor"),
		});

		await command(harness).handler("import native", ctx);

		expect(asCredential(storage.get(PROVIDER_ID)).accounts ?? []).toMatchObject([
			{
				name: "native",
				access: "native-access-token",
				refresh: "native-refresh-token",
				source: "import",
			},
		]);
		expect(JSON.stringify(storage.get("cursor"))).toBe(nativeBefore);
		expect(persistEnabled).toHaveBeenCalledWith("/tmp/cursor-account-command", true);
		expect(refresh).toHaveBeenCalledWith({ allowNetwork: false, providers: [PROVIDER_ID] });
		expect(lastNotice(notices)).toContain("native");
	});

	it("surfaces an import failure as an error without changing the store", async () => {
		const storage = AuthStorage.inMemory({ [PROVIDER_ID]: credential(slot("alpha")) });
		const { ctx, notices } = createContext(storage);
		const before = JSON.stringify(storage.get(PROVIDER_ID));
		const harness = createHarness({
			importCredential: async () => {
				throw new Error("No local Cursor OAuth credential found");
			},
		});

		await command(harness).handler("import", ctx);

		expect(JSON.stringify(storage.get(PROVIDER_ID))).toBe(before);
		expect(notices.at(-1)?.type).toBe("error");
		expect(lastNotice(notices)).toContain("No local Cursor OAuth credential found");
	});

	it("renders every status field with no token substring", async () => {
		const storage = AuthStorage.inMemory({
			[PROVIDER_ID]: credential(
				slot("alpha"),
				{ ...slot("personal"), blockedUntil: FIXED_NOW + 60_000, blockReason: "rate_limit" },
				{ ...slot("backup"), blockReason: "auth_error" },
			),
		});
		const router = new CursorCliSessionRouter({ now: () => FIXED_NOW });
		router.observeInit(
			{ senpiSessionId: "session-01", accountName: "alpha" },
			{ chatId: "chat-abc-123", model: "composer-2.5" },
			FIXED_NOW,
		);
		const { ctx, notices } = createContext(storage);
		const harness = createHarness({
			loadSettings: () => defaultSettings({ pinnedAccount: "alpha" }),
			now: () => FIXED_NOW,
			router,
			resolveExecutable: () => "/opt/cursor-agent/cursor-agent",
			probeVersion: async () => "2026.08.09-e8db854",
			readNativeCredential: () =>
				({
					type: "oauth",
					access: "native-access-token",
					refresh: "native-refresh-token",
					expires: FIXED_NOW + 3_600_000,
				}) as Credential,
		});

		await command(harness).handler("status", ctx);

		const output = lastNotice(notices);
		expect(output).toContain("Auth lane: file-store");
		expect(output).toContain("Context owner: senpi");
		expect(output).toContain("Selected account: alpha (pinned)");
		expect(output).toContain("Chat id: chat-abc-123");
		expect(output).toContain("Last model: composer-2.5");
		expect(output).toContain("Executable: /opt/cursor-agent/cursor-agent");
		expect(output).toContain("2026.08.09-e8db854");
		expect(output).toContain(`below the minimum known-good ${CURSOR_CLI_MINIMUM_KNOWN_GOOD_VERSION}`);
		expect(output).toContain("personal: rate_limit, expires 2026-08-17T12:01:00.000Z");
		expect(output).toContain("backup: auth_error, until re-login");
		expect(output).toContain("Recommended default");
		expect(output).toContain("native");
		expect(output).not.toContain("SECRET-ACCESS");
		expect(output).not.toContain("SECRET-REFRESH");
		expect(output).not.toContain("native-access-token");
	});

	it("omits the native recommendation when the native provider is not configured", async () => {
		const storage = AuthStorage.inMemory({ [PROVIDER_ID]: credential(slot("alpha")) });
		const { ctx, notices } = createContext(storage);
		const harness = createHarness({
			resolveExecutable: () => "/opt/cursor-agent/cursor-agent",
			probeVersion: async () => `v${CURSOR_CLI_MINIMUM_KNOWN_GOOD_VERSION}`,
		});

		await command(harness).handler("status", ctx);

		const output = lastNotice(notices);
		expect(output).toContain("Auth lane: file-store");
		expect(output).not.toContain("below the minimum known-good");
		expect(output).not.toContain("Recommended default");
		expect(output).not.toContain("SECRET-ACCESS");
	});
});

describe("/cursor-account acknowledge", () => {
	it("presents the explanation once and persists the acknowledgement on explicit confirmation", async () => {
		const storage = AuthStorage.inMemory({ [PROVIDER_ID]: credential(slot("alpha")) });
		const input = vi.fn(async (_title: string) => "yes");
		const persist = vi.fn();
		const { ctx, notices } = createContext(storage, "session-01", { input });
		const harness = createHarness({ persistAcknowledgement: persist, now: () => FIXED_NOW });

		await command(harness).handler("acknowledge", ctx);

		expect(input).toHaveBeenCalledTimes(1);
		expect(input.mock.calls[0]?.[0]).toContain("no senpi approval");
		expect(input.mock.calls[0]?.[0]).toContain("no senpi sandboxing");
		expect(input.mock.calls[0]?.[0]).toContain("no tool-level audit");
		expect(input.mock.calls[0]?.[0]).toContain("executionMode");
		expect(persist).toHaveBeenCalledTimes(1);
		expect(persist).toHaveBeenCalledWith("/tmp/cursor-account-command", new Date(FIXED_NOW).toISOString());
		expect(lastNotice(notices)).toContain("Acknowledged");
	});

	it("leaves the acknowledgement unwritten when the user declines", async () => {
		const storage = AuthStorage.inMemory({ [PROVIDER_ID]: credential(slot("alpha")) });
		const input = vi.fn(async (_title: string) => "no");
		const persist = vi.fn();
		const { ctx, notices } = createContext(storage, "session-01", { input });
		const harness = createHarness({ persistAcknowledgement: persist, now: () => FIXED_NOW });

		await command(harness).handler("acknowledge", ctx);

		expect(input).toHaveBeenCalledTimes(1);
		expect(persist).not.toHaveBeenCalled();
		expect(lastNotice(notices)).toContain("No acknowledgement written");
	});

	it("requires an interactive UI and persists nothing without one", async () => {
		const storage = AuthStorage.inMemory({ [PROVIDER_ID]: credential(slot("alpha")) });
		const input = vi.fn(async (_title: string) => "yes");
		const persist = vi.fn();
		const { ctx, notices } = createContext(storage, "session-01", { hasUI: false, input });
		const harness = createHarness({ persistAcknowledgement: persist, now: () => FIXED_NOW });

		await command(harness).handler("acknowledge", ctx);

		expect(input).not.toHaveBeenCalled();
		expect(persist).not.toHaveBeenCalled();
		expect(notices.at(-1)?.type).toBe("error");
	});
});
