import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import {
	type ClaudeAccountCommandDeps,
	getSessionClaudeAccountPin,
	registerClaudeAccountCommand,
	resolveClaudeAccountPin,
} from "../../src/core/extensions/builtin/anthropic-subscription/account-command.ts";
import {
	type AccountSlot,
	type AnthropicSubscriptionCredential,
	addAccount,
	emptyCredential,
} from "../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { selectAccount } from "../../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import type { AnthropicSubscriptionProviderSettings } from "../../src/core/extensions/builtin/anthropic-subscription/settings.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../../src/core/extensions/types.ts";

const PROVIDER_ID = "anthropic-subscription";

type Command = Pick<RegisteredCommand, "handler">;
type SessionHandler = (event: unknown, ctx: ExtensionCommandContext) => Promise<void> | void;
type Notice = { message: string; type: "info" | "warning" | "error" | undefined };

type CommandHarness = {
	commands: Map<string, Command>;
	handlers: Map<string, SessionHandler>;
	flags: Map<string, { type: "boolean" | "string"; description: string | undefined }>;
};

function slot(name: string, source: AccountSlot["source"] = "login"): AccountSlot {
	return { name, source, access: `${name}-access`, refresh: `${name}-refresh`, expires: 9_999_999_999_999 };
}

function credential(...accounts: AccountSlot[]): AnthropicSubscriptionCredential {
	return accounts.reduce((current, account) => addAccount(current, account), emptyCredential());
}

function createHarness(
	flagValue: string | undefined = undefined,
	settings: AnthropicSubscriptionProviderSettings = {},
): CommandHarness {
	const commands = new Map<string, Command>();
	const handlers = new Map<string, SessionHandler>();
	const flags = new Map<string, { type: "boolean" | "string"; description: string | undefined }>();
	const deps: ClaudeAccountCommandDeps = {
		loadSettings: () => settings,
		environment: () => undefined,
	};
	const pi = {
		registerCommand: (name: string, command: Command) => commands.set(name, command),
		registerFlag: (
			name: string,
			options: { type: "boolean" | "string"; description?: string; default?: boolean | string },
		) => flags.set(name, { type: options.type, description: options.description }),
		getFlag: () => flagValue,
		on: (event: string, handler: SessionHandler) => handlers.set(event, handler),
	} as unknown as ExtensionAPI;
	registerClaudeAccountCommand(pi, deps);
	return { commands, handlers, flags };
}

function createContext(
	storage: AuthStorage,
	sessionId = "session-01",
): {
	ctx: ExtensionCommandContext;
	notices: Notice[];
} {
	const notices: Notice[] = [];
	return {
		ctx: {
			hasUI: true,
			cwd: "/tmp/claude-account-command",
			signal: undefined,
			sessionManager: { getSessionId: () => sessionId },
			modelRegistry: { authStorage: storage },
			ui: {
				notify: (message: string, type?: Notice["type"]) => notices.push({ message, type }),
			},
		} as unknown as ExtensionCommandContext,
		notices,
	};
}

function command(harness: CommandHarness): Command {
	const registered = harness.commands.get("claude-account");
	if (!registered) throw new Error("/claude-account was not registered");
	return registered;
}

describe("/claude-account", () => {
	it("lists account slots with source, blocked state, pin state, and the current affinity pick", async () => {
		const storage = AuthStorage.inMemory({
			[PROVIDER_ID]: credential(slot("alpha"), {
				...slot("bravo", "import"),
				blockedUntil: Date.now() + 60_000,
				blockReason: "rate_limit",
			}),
		});
		const { ctx, notices } = createContext(storage);
		const harness = createHarness(undefined, { pinnedAccount: "alpha" });

		await command(harness).handler("", ctx);

		const output = notices.at(-1)?.message ?? "";
		expect(output).toContain("alpha | login | available | pinned | affinity pick");
		expect(output).toContain("bravo | import | blocked until");
		expect(output).toContain("Pinned account: alpha (settings)");
		expect(output).toContain("Affinity pick: alpha");
	});

	it("persists a pin that deterministically overrides HRW selection", async () => {
		const storage = AuthStorage.inMemory({ [PROVIDER_ID]: credential(slot("alpha"), slot("bravo")) });
		const { ctx, notices } = createContext(storage);
		const harness = createHarness();

		await command(harness).handler("pin bravo", ctx);

		const stored = storage.get(PROVIDER_ID) as AnthropicSubscriptionCredential;
		expect(stored.pinned).toBe("bravo");
		expect(selectAccount(stored.accounts ?? [], { sessionId: "session-01", pinnedAccount: stored.pinned }).name).toBe(
			"bravo",
		);
		expect(notices.at(-1)).toEqual({ message: "Pinned Anthropic Subscription account: bravo.", type: "info" });
	});

	it("makes the session-scoped CLI flag override the configured settings pin", async () => {
		const storage = AuthStorage.inMemory({
			[PROVIDER_ID]: credential(slot("alpha"), slot("bravo"), slot("charlie")),
		});
		const { ctx } = createContext(storage, "flag-session");
		const harness = createHarness("bravo", { pinnedAccount: "alpha" });
		const start = harness.handlers.get("session_start");
		if (!start) throw new Error("session_start handler was not registered");

		await start({}, ctx);

		const stored = storage.get(PROVIDER_ID) as AnthropicSubscriptionCredential;
		const pin = resolveClaudeAccountPin(getSessionClaudeAccountPin("flag-session"), "alpha", stored.pinned);
		expect(pin).toBe("bravo");
		expect(selectAccount(stored.accounts ?? [], { sessionId: "flag-session", pinnedAccount: pin }).name).toBe(
			"bravo",
		);
		expect(harness.flags.get("claude-account")).toEqual({
			type: "string",
			description: "Pin Anthropic Subscription account for this session.",
		});
		await harness.handlers.get("session_shutdown")?.({}, ctx);
	});

	it("reports an unknown pin without changing the stored account state", async () => {
		const storage = AuthStorage.inMemory({ [PROVIDER_ID]: credential(slot("alpha"), slot("bravo")) });
		const { ctx, notices } = createContext(storage);
		const harness = createHarness();
		const before = JSON.stringify(storage.get(PROVIDER_ID));

		await command(harness).handler("pin missing", ctx);

		expect(JSON.stringify(storage.get(PROVIDER_ID))).toBe(before);
		expect(notices.at(-1)).toEqual({
			message: "Anthropic Subscription account 'missing' does not exist.",
			type: "error",
		});
	});
});
