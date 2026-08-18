import type { Credential } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "../../types.ts";
import { emitProviderAccountsChanged } from "../claude-sdk-oauth/account-events.ts";
import {
	type CursorCliAccountSlot,
	type CursorCliOauthCredential,
	emptyCredential,
	listAccounts,
	pinAccount,
	removeAccount,
} from "./accounts.ts";
import { selectAccount } from "./affinity.ts";
import {
	type CursorCliGenerationGuard,
	collectCursorCliStatus,
	NATIVE_CURSOR_PROVIDER_ID,
	registerCursorCliShutdownSafety,
	renderCursorCliStatus,
} from "./diagnostics.ts";
import {
	CURSOR_CLI_OAUTH_PROVIDER_ID,
	confirmCursorCliNoApprovalAcknowledgement,
	importLocalCursorCredential,
	importNativeCursorCredential,
	type LocalCursorImportDeps,
} from "./oauth-login.ts";
import { type CursorCliSessionRouter, cursorCliSessionRouter } from "./session-router.ts";
import {
	type CursorCliOauthProviderSettings,
	loadCursorCliOauthProviderSettingsFromDisk,
	persistCursorCliNoApprovalAcknowledgement,
	persistCursorCliOauthEnabled,
} from "./settings.ts";

/** Injectable seams; every default resolves real on-disk state at invocation time. */
export type CursorCliAccountCommandDeps = {
	readonly loadSettings?: (cwd: string) => CursorCliOauthProviderSettings;
	readonly router?: CursorCliSessionRouter;
	readonly resolveExecutable?: (settings: CursorCliOauthProviderSettings) => string;
	readonly probeVersion?: (executable: string) => Promise<string>;
	readonly readNativeCredential?: () => Credential | undefined | Promise<Credential | undefined>;
	readonly importCredential?: typeof importLocalCursorCredential;
	readonly importNativeCredential?: typeof importNativeCursorCredential;
	readonly importDeps?: LocalCursorImportDeps;
	/** Acknowledgement persistence seam; the default read-modify-writes the global settings file. */
	readonly persistAcknowledgement?: (cwd: string, acknowledgedAt: string) => void;
	/** Enablement persistence seam; explicit login/import actions activate the fallback lane. */
	readonly persistEnabled?: (cwd: string, enabled: boolean) => void;
	readonly now?: () => number;
	readonly generation?: CursorCliGenerationGuard;
};

const USAGE =
	"Usage: /cursor-account [list | add | remove <name> | pin <name> | unpin | import [local | native] | acknowledge | status]";

function asCursorCredential(value: Credential | undefined): CursorCliOauthCredential {
	return value !== undefined && value.type === "oauth" ? (value as CursorCliOauthCredential) : emptyCredential();
}

function parseArgs(rawArgs: string): string[] {
	return rawArgs.trim().split(/\s+/).filter(Boolean);
}

function slotStatus(slot: CursorCliAccountSlot, now: number): string {
	if (slot.blockReason === "auth_error") return "blocked until re-login";
	if (slot.blockedUntil !== undefined && slot.blockedUntil > now) {
		return `blocked until ${new Date(slot.blockedUntil).toISOString()} (${slot.blockReason ?? "rate_limit"})`;
	}
	return "available";
}

function authEventMessage(event: unknown): string {
	if (event === null || typeof event !== "object") return "Cursor CLI (OAuth) authentication update.";
	const value = event as Record<string, unknown>;
	if (value.type === "auth_url" && typeof value.url === "string") {
		return `Open this URL to authorize Cursor CLI (OAuth):\n${value.url}`;
	}
	if (value.type === "device_code" && typeof value.verificationUri === "string") {
		return `Open this URL to authorize Cursor CLI (OAuth):\n${value.verificationUri}`;
	}
	return typeof value.message === "string" ? value.message : "Cursor CLI (OAuth) authentication update.";
}

/**
 * Registers `/cursor-account` plus the reload/shutdown teardown for this
 * extension generation: the command reads account state fresh from the
 * credential store on every invocation, and every deferred continuation is
 * fenced so a retired generation is never touched after a reload.
 */
export function registerCursorCliAccountCommand(pi: ExtensionAPI, deps: CursorCliAccountCommandDeps = {}): void {
	const loadSettings = deps.loadSettings ?? ((cwd: string) => loadCursorCliOauthProviderSettingsFromDisk(cwd));
	const now = deps.now ?? Date.now;
	// One guard per registration: a reload rebuilds the extension and gets a
	// fresh fence, while the child registry stays process-wide.
	const generation = registerCursorCliShutdownSafety(pi, { generation: deps.generation });

	pi.registerCommand("cursor-account", {
		description: "List and manage Cursor CLI (OAuth) accounts.",
		argumentHint: "[list | add | remove <name> | pin <name> | unpin | import | acknowledge | status]",
		handler: async (rawArgs: string, ctx: ExtensionCommandContext): Promise<void> => {
			try {
				const args = parseArgs(rawArgs);
				const action = args[0] ?? "list";
				if (action === "list") {
					showAccounts(ctx, loadSettings(ctx.cwd), generation, now);
					return;
				}
				if (action === "add") {
					await addAccount(ctx);
					return;
				}
				if (action === "remove") {
					await removeNamedAccount(ctx, args[1]);
					return;
				}
				if (action === "pin" && args[1] !== undefined) {
					await pinNamedAccount(ctx, args[1]);
					return;
				}
				if (action === "unpin") {
					await unpinAccount(ctx);
					return;
				}
				if (action === "import") {
					const source = args[1] ?? "local";
					if (source !== "local" && source !== "native") {
						ctx.ui.notify(USAGE, "error");
						return;
					}
					await importAccount(ctx, deps, source);
					return;
				}
				if (action === "acknowledge") {
					await acknowledgeNoApproval(ctx, deps, generation);
					return;
				}
				if (action === "status") {
					await showStatus(ctx, deps, { loadSettings, generation, now });
					return;
				}
				ctx.ui.notify(USAGE, "error");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

function showAccounts(
	ctx: ExtensionCommandContext,
	settings: CursorCliOauthProviderSettings,
	generation: CursorCliGenerationGuard,
	now: () => number,
): void {
	const credential = asCursorCredential(ctx.modelRegistry.authStorage.get(CURSOR_CLI_OAUTH_PROVIDER_ID));
	const accounts = listAccounts(credential);
	const pinned = settings.pinnedAccount ?? credential.pinned;
	const pinSource = settings.pinnedAccount !== undefined ? "settings" : "stored";
	let affinityPick: string | undefined;
	let affinityError: string | undefined;
	if (accounts.length > 0) {
		try {
			affinityPick = selectAccount(accounts, {
				sessionId: ctx.sessionManager.getSessionId(),
				pinnedAccount: pinned,
				now: now(),
			}).name;
		} catch (error) {
			affinityError = error instanceof Error ? error.message : String(error);
		}
	}
	const lines = ["Cursor CLI (OAuth) accounts:"];
	if (accounts.length === 0) lines.push("  (none)");
	for (const account of accounts) {
		const states = [account.name, account.source, slotStatus(account, now())];
		if (account.name === pinned) states.push("pinned");
		if (account.name === affinityPick) states.push("affinity pick");
		lines.push(`  ${states.join(" | ")}`);
	}
	lines.push(`Pinned account: ${pinned === undefined ? "none" : `${pinned} (${pinSource})`}`);
	lines.push(`Affinity pick: ${affinityPick ?? (affinityError ? `unavailable - ${affinityError}` : "none")}`);
	generation.runFencedSync(ctx, () => ctx.ui.notify(lines.join("\n"), "info"));
}

async function addAccount(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/cursor-account add requires an interactive UI.", "error");
		return;
	}
	try {
		await ctx.modelRegistry.modelRuntime.login(CURSOR_CLI_OAUTH_PROVIDER_ID, "oauth", {
			signal: ctx.signal,
			prompt: async (prompt: { message: string }) => {
				const answer = await ctx.ui.input(prompt.message);
				if (answer === undefined) throw new Error("Login cancelled");
				return answer;
			},
			notify: (event: unknown) => ctx.ui.notify(authEventMessage(event), "info"),
		});
		emitProviderAccountsChanged(CURSOR_CLI_OAUTH_PROVIDER_ID);
		ctx.ui.notify("Cursor CLI (OAuth) account added.", "info");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message !== "Login cancelled") {
			ctx.ui.notify(`Failed to add Cursor CLI (OAuth) account: ${message}`, "error");
		}
	}
}

async function removeNamedAccount(ctx: ExtensionCommandContext, name: string | undefined): Promise<void> {
	if (!name) {
		ctx.ui.notify("Usage: /cursor-account remove <name>", "error");
		return;
	}
	let removed = false;
	try {
		await ctx.modelRegistry.authStorage.modify(CURSOR_CLI_OAUTH_PROVIDER_ID, async (current) => {
			const credential = asCursorCredential(current);
			if (!listAccounts(credential).some((account) => account.name === name)) return current;
			removed = true;
			return removeAccount(credential, name);
		});
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}
	if (!removed) {
		ctx.ui.notify(`Cursor CLI (OAuth) account '${name}' does not exist.`, "error");
		return;
	}
	emitProviderAccountsChanged(CURSOR_CLI_OAUTH_PROVIDER_ID);
	ctx.ui.notify(`Removed Cursor CLI (OAuth) account: ${name}.`, "info");
}

async function pinNamedAccount(ctx: ExtensionCommandContext, name: string): Promise<void> {
	try {
		await ctx.modelRegistry.authStorage.modify(CURSOR_CLI_OAUTH_PROVIDER_ID, async (current) => {
			const credential = asCursorCredential(current);
			if (!listAccounts(credential).some((account) => account.name === name)) {
				throw new Error(`Cursor CLI (OAuth) account '${name}' does not exist.`);
			}
			return pinAccount(credential, name);
		});
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}
	emitProviderAccountsChanged(CURSOR_CLI_OAUTH_PROVIDER_ID);
	ctx.ui.notify(`Pinned Cursor CLI (OAuth) account: ${name}.`, "info");
}

async function unpinAccount(ctx: ExtensionCommandContext): Promise<void> {
	let hadPin = false;
	try {
		await ctx.modelRegistry.authStorage.modify(CURSOR_CLI_OAUTH_PROVIDER_ID, async (current) => {
			const credential = asCursorCredential(current);
			if (credential.pinned === undefined) return current;
			hadPin = true;
			const { pinned: _pinned, ...unpinned } = credential;
			return unpinned;
		});
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}
	if (!hadPin) {
		ctx.ui.notify("No stored Cursor CLI (OAuth) account pin is set.", "info");
		return;
	}
	emitProviderAccountsChanged(CURSOR_CLI_OAUTH_PROVIDER_ID);
	ctx.ui.notify("Unpinned Cursor CLI (OAuth) account.", "info");
}

async function importAccount(
	ctx: ExtensionCommandContext,
	deps: CursorCliAccountCommandDeps,
	source: "local" | "native",
): Promise<void> {
	const importCredential = deps.importCredential ?? importLocalCursorCredential;
	const importNativeCredential = deps.importNativeCredential ?? importNativeCursorCredential;
	const importDeps: LocalCursorImportDeps = { ...deps.importDeps };
	if (importDeps.onPrompt === undefined && ctx.hasUI) {
		importDeps.onPrompt = async (prompt: { message: string }) => {
			const answer = await ctx.ui.input(prompt.message);
			if (answer === undefined) throw new Error("Import cancelled");
			return answer;
		};
	}
	let importedName: string | undefined;
	try {
		await ctx.modelRegistry.authStorage.modify(CURSOR_CLI_OAUTH_PROVIDER_ID, async (current) => {
			const before = asCursorCredential(current);
			const updated =
				source === "native"
					? await importNativeCredential(
							before,
							deps.readNativeCredential ?? (() => ctx.modelRegistry.authStorage.get(NATIVE_CURSOR_PROVIDER_ID)),
						)
					: await importCredential(before, importDeps);
			const existing = new Set(listAccounts(before).map((account) => account.name));
			importedName = listAccounts(updated).find((account) => !existing.has(account.name))?.name;
			return updated;
		});
	} catch (error) {
		ctx.ui.notify(
			`Failed to import local Cursor credential: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return;
	}
	const persistEnabled = deps.persistEnabled ?? persistCursorCliOauthEnabled;
	try {
		persistEnabled(ctx.cwd, true);
		await ctx.modelRegistry.modelRuntime.refresh({
			allowNetwork: false,
			providers: [CURSOR_CLI_OAUTH_PROVIDER_ID],
		});
	} catch (error) {
		ctx.ui.notify(
			`Imported ${source === "native" ? "native " : ""}Cursor credential, but provider activation failed: ${error instanceof Error ? error.message : String(error)}`,
			"warning",
		);
		return;
	}
	emitProviderAccountsChanged(CURSOR_CLI_OAUTH_PROVIDER_ID);
	ctx.ui.notify(
		`Imported ${source === "native" ? "native " : "local "}Cursor credential as '${importedName ?? "a new account"}' (copied into this provider's store).`,
		"info",
	);
}

async function acknowledgeNoApproval(
	ctx: ExtensionCommandContext,
	deps: CursorCliAccountCommandDeps,
	generation: CursorCliGenerationGuard,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/cursor-account acknowledge requires an interactive UI.", "error");
		return;
	}
	const persist = deps.persistAcknowledgement ?? persistCursorCliNoApprovalAcknowledgement;
	const acknowledgedAt = await confirmCursorCliNoApprovalAcknowledgement(
		async (ask) => (await ctx.ui.input(ask.message)) ?? "",
		() => new Date((deps.now ?? Date.now)()),
	);
	if (acknowledgedAt === undefined) {
		generation.runFencedSync(ctx, () =>
			ctx.ui.notify(
				"No acknowledgement written: unattended Cursor CLI execution stays off until you acknowledge.",
				"info",
			),
		);
		return;
	}
	persist(ctx.cwd, acknowledgedAt);
	generation.runFencedSync(ctx, () =>
		ctx.ui.notify(`Acknowledged unattended Cursor CLI tool execution at ${acknowledgedAt}.`, "info"),
	);
}

async function showStatus(
	ctx: ExtensionCommandContext,
	deps: CursorCliAccountCommandDeps,
	bound: {
		loadSettings: (cwd: string) => CursorCliOauthProviderSettings;
		generation: CursorCliGenerationGuard;
		now: () => number;
	},
): Promise<void> {
	// Context reads happen before any await; the render continuation is fenced
	// so a reload during the version probe can never touch a retired context.
	const sessionId = ctx.sessionManager.getSessionId();
	const report = await collectCursorCliStatus({
		sessionId,
		settings: bound.loadSettings(ctx.cwd),
		readCredential: () => ctx.modelRegistry.authStorage.get(CURSOR_CLI_OAUTH_PROVIDER_ID),
		readNativeCredential:
			deps.readNativeCredential ?? (() => ctx.modelRegistry.authStorage.get(NATIVE_CURSOR_PROVIDER_ID)),
		router: deps.router ?? cursorCliSessionRouter,
		resolveExecutable: deps.resolveExecutable,
		probeVersion: deps.probeVersion,
		now: bound.now,
	});
	bound.generation.runFencedSync(ctx, () => ctx.ui.notify(renderCursorCliStatus(report), "info"));
}
