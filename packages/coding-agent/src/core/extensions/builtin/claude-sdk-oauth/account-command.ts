import type { Credential } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "../../types.ts";
import { emitProviderAccountsChanged } from "./account-events.ts";
import { CLAUDE_SDK_OAUTH_PROVIDER_ID, pinProviderAccount, removeProviderAccount } from "./account-management.ts";
import { type AccountSlot, type ClaudeSdkOauthCredential, emptyCredential, listAccounts } from "./accounts.ts";
import { selectAccount } from "./affinity.ts";
import { type ClaudeSdkOauthProviderSettings, loadClaudeSdkOauthProviderSettingsFromDisk } from "./settings.ts";

const cliPinsBySession = new Map<string, string>();

type CommandEnvironment = (name: string) => string | undefined;

export interface ClaudeAccountCommandDeps {
	loadSettings?: (cwd: string) => ClaudeSdkOauthProviderSettings;
	environment?: CommandEnvironment;
}

function asCredential(value: Credential | undefined): ClaudeSdkOauthCredential | undefined {
	return value?.type === "oauth" ? (value as ClaudeSdkOauthCredential) : undefined;
}

function slotStatus(slot: AccountSlot): string {
	if (slot.blockReason === "auth_error") return "blocked until re-login";
	if (slot.blockedUntil !== undefined && slot.blockedUntil > Date.now()) {
		return `blocked until ${new Date(slot.blockedUntil).toISOString()}`;
	}
	return "available";
}

function readAccounts(
	ctx: ExtensionCommandContext,
	environment: CommandEnvironment,
): {
	credential: ClaudeSdkOauthCredential | undefined;
	accounts: AccountSlot[];
} {
	const credential = asCredential(ctx.modelRegistry.authStorage.get(CLAUDE_SDK_OAUTH_PROVIDER_ID));
	return {
		credential,
		accounts: listAccounts(credential ?? emptyCredential(), environment),
	};
}

function accountError(ctx: ExtensionCommandContext, name: string): void {
	ctx.ui.notify(`Claude SDK OAuth account '${name}' does not exist.`, "error");
}

function parseArgs(rawArgs: string): string[] {
	return rawArgs.trim().split(/\s+/).filter(Boolean);
}

function authEventMessage(event: unknown): string {
	if (event === null || typeof event !== "object") return "Claude SDK OAuth authentication update.";
	const value = event as Record<string, unknown>;
	if (value.type === "auth_url" && typeof value.url === "string") {
		return `Open this URL to authorize Claude SDK OAuth:\n${value.url}`;
	}
	if (value.type === "device_code" && typeof value.verificationUri === "string") {
		return `Open this URL to authorize Claude SDK OAuth:\n${value.verificationUri}`;
	}
	return typeof value.message === "string" ? value.message : "Claude SDK OAuth authentication update.";
}

export function getSessionClaudeAccountPin(sessionId: string | undefined): string | undefined {
	return sessionId === undefined ? undefined : cliPinsBySession.get(sessionId);
}

/** CLI pins are request-local overrides; settings and stored pins remain fallback choices. */
export function resolveClaudeAccountPin(
	cliPinnedAccount: string | undefined,
	settingsPinnedAccount: string | undefined,
	storedPinnedAccount: string | undefined,
): string | undefined {
	return cliPinnedAccount ?? settingsPinnedAccount ?? storedPinnedAccount;
}

export function registerClaudeAccountCommand(pi: ExtensionAPI, deps: ClaudeAccountCommandDeps = {}): void {
	const loadSettings = deps.loadSettings ?? loadClaudeSdkOauthProviderSettingsFromDisk;
	const environment = deps.environment ?? ((name: string) => process.env[name]);

	pi.registerFlag("claude-account", {
		type: "string",
		description: "Pin Claude SDK OAuth account for this session.",
	});
	pi.on("session_start", (_event, ctx) => {
		const flag = pi.getFlag("claude-account");
		const sessionId = ctx.sessionManager.getSessionId();
		if (typeof flag === "string" && flag.length > 0) cliPinsBySession.set(sessionId, flag);
		else cliPinsBySession.delete(sessionId);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		cliPinsBySession.delete(ctx.sessionManager.getSessionId());
	});
	pi.registerCommand("claude-account", {
		description: "List and manage Claude SDK OAuth accounts.",
		argumentHint: "[add | remove <name> | pin <name> | unpin]",
		handler: async (rawArgs, ctx) => {
			const args = parseArgs(rawArgs);
			const action = args[0] ?? "list";
			if (action === "list") {
				showAccounts(ctx, loadSettings(ctx.cwd), environment);
				return;
			}
			if (action === "add") {
				await addAccount(ctx);
				return;
			}
			if (action === "remove") {
				await removeNamedAccount(ctx, args[1], environment);
				return;
			}
			if (action === "pin" && args[1] !== "unpin") {
				await pinNamedAccount(ctx, args[1], environment);
				return;
			}
			if (action === "unpin" || (action === "pin" && args[1] === "unpin")) {
				await unpinAccount(ctx);
				return;
			}
			ctx.ui.notify("Usage: /claude-account [add | remove <name> | pin <name> | unpin]", "error");
		},
	});
}

function showAccounts(
	ctx: ExtensionCommandContext,
	settings: ClaudeSdkOauthProviderSettings,
	environment: CommandEnvironment,
): void {
	const { credential, accounts } = readAccounts(ctx, environment);
	const cliPin = getSessionClaudeAccountPin(ctx.sessionManager.getSessionId());
	const pinned = resolveClaudeAccountPin(cliPin, settings.pinnedAccount, credential?.pinned);
	const pinSource = cliPin !== undefined ? "CLI" : settings.pinnedAccount !== undefined ? "settings" : "stored";
	let affinityPick: string | undefined;
	let affinityError: string | undefined;
	if (accounts.length > 0) {
		try {
			affinityPick = selectAccount(accounts, {
				sessionId: ctx.sessionManager.getSessionId(),
				pinnedAccount: pinned,
			}).name;
		} catch (error) {
			affinityError = error instanceof Error ? error.message : String(error);
		}
	}
	const lines = ["Claude SDK OAuth accounts:"];
	if (accounts.length === 0) lines.push("  (none)");
	for (const account of accounts) {
		const states = [account.name, account.source, slotStatus(account)];
		if (account.name === pinned) states.push("pinned");
		if (account.name === affinityPick) states.push("affinity pick");
		lines.push(`  ${states.join(" | ")}`);
	}
	lines.push(`Pinned account: ${pinned === undefined ? "none" : `${pinned} (${pinSource.toLowerCase()})`}`);
	lines.push(`Affinity pick: ${affinityPick ?? (affinityError ? `unavailable - ${affinityError}` : "none")}`);
	ctx.ui.notify(lines.join("\n"), "info");
}

async function addAccount(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/claude-account add requires an interactive UI.", "error");
		return;
	}
	try {
		await ctx.modelRegistry.modelRuntime.login(CLAUDE_SDK_OAUTH_PROVIDER_ID, "oauth", {
			signal: ctx.signal,
			prompt: async (prompt) => {
				if (prompt.type === "select") {
					const labels = prompt.options.map((option) => option.label);
					const selected = await ctx.ui.select(prompt.message, labels);
					const id = prompt.options.find((option) => option.label === selected)?.id;
					if (!id) throw new Error("Login cancelled");
					return id;
				}
				const answer = await ctx.ui.input(prompt.message);
				if (answer === undefined) throw new Error("Login cancelled");
				return answer;
			},
			notify: (event) => ctx.ui.notify(authEventMessage(event), "info"),
		});
		emitProviderAccountsChanged(CLAUDE_SDK_OAUTH_PROVIDER_ID);
		ctx.ui.notify("Claude SDK OAuth account added.", "info");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message !== "Login cancelled") ctx.ui.notify(`Failed to add Claude SDK OAuth account: ${message}`, "error");
	}
}

async function removeNamedAccount(
	ctx: ExtensionCommandContext,
	name: string | undefined,
	environment: CommandEnvironment,
): Promise<void> {
	if (!name) {
		ctx.ui.notify("Usage: /claude-account remove <name>", "error");
		return;
	}
	const { accounts } = readAccounts(ctx, environment);
	const target = accounts.find((account) => account.name === name);
	if (!target) return accountError(ctx, name);
	if (target.source === "env") {
		ctx.ui.notify(`Claude SDK OAuth account '${name}' comes from the environment and cannot be removed.`, "error");
		return;
	}
	try {
		await removeProviderAccount(ctx.modelRegistry.authStorage, CLAUDE_SDK_OAUTH_PROVIDER_ID, name);
		ctx.ui.notify(`Removed Claude SDK OAuth account: ${name}.`, "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

async function pinNamedAccount(
	ctx: ExtensionCommandContext,
	name: string | undefined,
	environment: CommandEnvironment,
): Promise<void> {
	if (!name) {
		ctx.ui.notify("Usage: /claude-account pin <name>", "error");
		return;
	}
	if (!readAccounts(ctx, environment).accounts.some((account) => account.name === name)) {
		return accountError(ctx, name);
	}
	try {
		await pinProviderAccount(ctx.modelRegistry.authStorage, CLAUDE_SDK_OAUTH_PROVIDER_ID, name);
		ctx.ui.notify(`Pinned Claude SDK OAuth account: ${name}.`, "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

async function unpinAccount(ctx: ExtensionCommandContext): Promise<void> {
	const credential = asCredential(ctx.modelRegistry.authStorage.get(CLAUDE_SDK_OAUTH_PROVIDER_ID));
	if (!credential?.pinned) {
		ctx.ui.notify("No stored Claude SDK OAuth account pin is set.", "info");
		return;
	}
	await pinProviderAccount(ctx.modelRegistry.authStorage, CLAUDE_SDK_OAUTH_PROVIDER_ID, null);
	ctx.ui.notify("Unpinned Claude SDK OAuth account.", "info");
}
