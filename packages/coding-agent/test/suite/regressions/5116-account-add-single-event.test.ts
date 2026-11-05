import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import {
	registerClaudeAccountCommand,
	type ClaudeAccountCommandDeps,
} from "../../../src/core/extensions/builtin/anthropic-subscription/account-command.ts";
import {
	emitProviderAccountsChanged,
	subscribeProviderAccountEvents,
	type ProviderAccountEvent,
} from "../../../src/core/extensions/builtin/anthropic-subscription/account-events.ts";
import type { ExtensionAPI, ExtensionCommandContext, RegisteredCommand } from "../../../src/core/extensions/types.ts";

const PROVIDER_ID = "anthropic-subscription";

type Command = Pick<RegisteredCommand, "handler">;

describe("senpi#5116: /claude-account add emits accounts_changed exactly once", () => {
	it("one add produces exactly one accounts_changed event", async () => {
		const events: ProviderAccountEvent[] = [];
		const unsubscribe = subscribeProviderAccountEvents((event) => events.push(event));
		try {
			const commands = new Map<string, Command>();
			const deps: ClaudeAccountCommandDeps = {
				loadSettings: () => ({}),
				environment: () => undefined,
			};
			const pi = {
				registerCommand: (name: string, command: Command) => commands.set(name, command),
				registerFlag: () => {},
				getFlag: () => undefined,
				on: () => {},
			} as unknown as ExtensionAPI;
			registerClaudeAccountCommand(pi, deps);
			const registered = commands.get("claude-account");
			if (!registered) throw new Error("/claude-account was not registered");

			const notices: string[] = [];
			const ctx = {
				hasUI: true,
				cwd: "/tmp/claude-account-add-event",
				signal: undefined,
				sessionManager: { getSessionId: () => "session-01" },
				modelRegistry: {
					authStorage: AuthStorage.inMemory({}),
					// Mirrors the real ModelRuntime.login: a successful login
					// emits accounts_changed with the "login" remedy.
					modelRuntime: {
						login: async (_provider: string, _type: string, _interaction: unknown) => {
							emitProviderAccountsChanged(PROVIDER_ID, "login");
							return { type: "oauth" };
						},
					},
				},
				ui: {
					notify: (message: string) => notices.push(message),
				},
			} as unknown as ExtensionCommandContext;

			await registered.handler("add", ctx);

			expect(notices).toContain("Anthropic Subscription account added.");
			expect(events).toHaveLength(1);
			expect(events[0]).toEqual({ type: "accounts_changed", provider: PROVIDER_ID, remedy: "login" });
		} finally {
			unsubscribe();
		}
	});
});
