import { afterEach, describe, expect, it, vi } from "vitest";
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
import { subscriptionLimits } from "../../src/core/subscription-limits/limit-store.ts";
import { cliSlot } from "../support/claude-cli-test-slots.ts";

const PROVIDER_ID = "anthropic-subscription";

type Command = Pick<RegisteredCommand, "handler">;
type SessionHandler = (event: unknown, ctx: ExtensionCommandContext) => Promise<void> | void;
type Notice = { message: string; type: "info" | "warning" | "error" | undefined };

type CommandHarness = {
	commands: Map<string, Command>;
	handlers: Map<string, SessionHandler>;
	flags: Map<string, { type: "boolean" | "string"; description: string | undefined }>;
};

function slot(name: string): AccountSlot {
	return cliSlot(name);
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
	// vitest.config.ts sets unstubEnvs, so a stubbed TZ is restored (or deleted) after each test.
	afterEach(() => {
		vi.useRealTimers();
	});

	// senpi#6288: one block per account, aligned rows, relative times with a short local clock, no ISO stamps.
	it("lists each account as a readable block with status, limit windows, pin and next-turn tags", async () => {
		vi.stubEnv("TZ", "UTC");
		const now = Date.UTC(2026, 10, 9, 12, 0); // Monday
		vi.useFakeTimers({ now, toFake: ["Date"] });
		const hour = 3_600_000;
		const storage = AuthStorage.inMemory({
			[PROVIDER_ID]: credential(
				cliSlot("alpha", { displayName: "Personal" }),
				cliSlot("bravo", { blockedUntil: now + 3 * hour, blockReason: "rate_limit" }),
				cliSlot("charlie", { modelBlocks: { fable: { blockedUntil: now + 26 * hour } } }),
			),
		});
		const at = (offset: number) => new Date(now + offset).toISOString();
		subscriptionLimits.record(PROVIDER_ID, "alpha", [
			{ id: "w:5h", label: "5h", usedPercent: 72.4, resetsAt: at(2 * hour) },
			{ id: "w:7d", label: "7d", usedPercent: 31, resetsAt: at(72 * hour) },
		]);
		subscriptionLimits.record(PROVIDER_ID, "bravo", [
			{ id: "w:5h", label: "5h", usedPercent: 100, resetsAt: at(3 * hour) },
		]);
		const { ctx, notices } = createContext(storage);
		const harness = createHarness(undefined, { pinnedAccount: "alpha" });

		await command(harness).handler("", ctx);

		expect(notices.at(-1)?.message).toBe(
			[
				"Anthropic Subscription accounts (3)",
				"",
				"Personal (alpha)  [pinned in settings, next turn]",
				"  status   available",
				"  5h        72% used, resets in 2 h (2:00 PM)",
				"  7d        31% used, resets in 3 d (Thu 12:00 PM)",
				"  updated  just now",
				"",
				"bravo",
				"  status   rate limited, retry in 3 h (3:00 PM)",
				"  5h       100% used, resets in 3 h (3:00 PM)",
				"  updated  just now",
				"",
				"charlie",
				"  status   fable blocked, retry in 1 d 2 h (Tue 2:00 PM)",
				"  limits   not reported yet",
				"",
				"Manage: /claude-account add | pin <id> | unpin | unblock <id> | remove <id>",
			].join("\n"),
		);
	});

	it("names a pin that matches no account and an unavailable next-turn pick below the list", async () => {
		const storage = AuthStorage.inMemory({ [PROVIDER_ID]: credential(slot("alpha")) });
		const { ctx, notices } = createContext(storage);
		const harness = createHarness(undefined, { pinnedAccount: "gone", accountFallback: false });

		await command(harness).handler("", ctx);

		const output = notices.at(-1)?.message ?? "";
		expect(output).toContain("Pinned account: gone (settings) - not in this list");
		expect(output).toMatch(/^Next turn: unavailable - .+/m);
		expect(output).not.toContain("[pinned");
	});

	it("keeps naming the configured pin when no account is stored", async () => {
		const storage = AuthStorage.inMemory({});
		const { ctx, notices } = createContext(storage);
		const harness = createHarness(undefined, { pinnedAccount: "gone" });

		await command(harness).handler("", ctx);

		expect(notices.at(-1)?.message).toBe(
			[
				"Anthropic Subscription accounts: none",
				"Pinned account: gone (settings) - not in this list",
				"Add one with /claude-account add.",
			].join("\n"),
		);
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
