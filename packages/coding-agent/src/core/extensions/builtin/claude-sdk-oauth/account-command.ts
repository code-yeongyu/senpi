import type { AccountLoginReceipt, Credential } from "@earendil-works/pi-ai";
import { accountLabel } from "@earendil-works/pi-ai/auth/pool/slots";
import type { ExtensionAPI, ExtensionCommandContext } from "../../types.ts";
import { accountDisplayNameCommand, promptAccountDisplayName } from "../account-display-name.ts";
import { createExtensionLoginInteraction, LOGIN_CANCELLED_MESSAGE } from "../oauth-login-interaction.ts";
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
	/** Browser launcher for the OAuth authorize URL; tests inject a recorder. */
	openBrowser?: ((url: string) => void) | undefined;
}

const CLAUDE_SDK_OAUTH_PROVIDER_LABEL = "Claude SDK OAuth";

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
		argumentHint: "[add | remove <id> | pin <id> | unpin | rename <id> <display name...> | clear-name <id>]",
		handler: async (rawArgs, ctx) => {
			if (await accountDisplayNameCommand(ctx, CLAUDE_SDK_OAUTH_PROVIDER_ID, rawArgs)) return;
			const args = parseArgs(rawArgs);
			const action = args[0] ?? "list";
			if (action === "list") {
				showAccounts(ctx, loadSettings(ctx.cwd), environment);
				return;
			}
			if (action === "add") {
				await addAccount(ctx, deps);
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
			ctx.ui.notify(
				"Usage: /claude-account [add | remove <id> | pin <id> | unpin | rename <id> <display name...> | clear-name <id>]",
				"error",
			);
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
		const states = [accountLabel(account), account.source, slotStatus(account)];
		if (account.name === pinned) states.push("pinned");
		if (account.name === affinityPick) states.push("affinity pick");
		lines.push(`  ${states.join(" | ")}`);
	}
	const labelFor = (name: string) => accountLabel(accounts.find((account) => account.name === name) ?? { name });
	lines.push(`Pinned account: ${pinned === undefined ? "none" : `${labelFor(pinned)} (${pinSource.toLowerCase()})`}`);
	lines.push(
		`Affinity pick: ${affinityPick === undefined ? (affinityError ? `unavailable - ${affinityError}` : "none") : labelFor(affinityPick)}`,
	);
	ctx.ui.notify(lines.join("\n"), "info");
}

async function addAccount(ctx: ExtensionCommandContext, deps: ClaudeAccountCommandDeps): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/claude-account add requires an interactive UI.", "error");
		return;
	}
	try {
		let receipt: AccountLoginReceipt | undefined;
		await ctx.modelRegistry.modelRuntime.login(CLAUDE_SDK_OAUTH_PROVIDER_ID, "oauth", {
			...createExtensionLoginInteraction(ctx, {
				providerLabel: CLAUDE_SDK_OAUTH_PROVIDER_LABEL,
				openBrowser: deps.openBrowser,
			}),
			onAccountCommitted: (committed) => {
				receipt = committed;
			},
		});
		emitProviderAccountsChanged(CLAUDE_SDK_OAUTH_PROVIDER_ID);
		ctx.ui.notify("Claude SDK OAuth account added.", "info");
		await promptAccountDisplayName(ctx, receipt);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message !== LOGIN_CANCELLED_MESSAGE) {
			ctx.ui.notify(`Failed to add Claude SDK OAuth account: ${message}`, "error");
		}
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
