import type { AccountLoginReceipt } from "@earendil-works/pi-ai";
import { accountLabel } from "@earendil-works/pi-ai/auth/pool/slots";
import { unblockPooledAccount } from "../../../core/credential-account-unblock.ts";
import {
	getCredentialAccounts,
	pinCredentialAccount,
	removeCredentialAccount,
} from "../../../core/credential-accounts.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../types.ts";
import { accountDisplayNameCommand, promptAccountDisplayName } from "./account-display-name.ts";
import { emitProviderAccountsChanged } from "./anthropic-subscription/account-events.ts";
import { createExtensionLoginInteraction, LOGIN_CANCELLED_MESSAGE } from "./oauth-login-interaction.ts";

const CHATGPT_SUBSCRIPTION_PROVIDER_ID = "chatgpt-subscription";
const CHATGPT_SUBSCRIPTION_PROVIDER_LABEL = "ChatGPT Subscription OAuth";
const USAGE_ACTIONS =
	"[add | remove <id> | pin <id> | unpin | unblock <id> | rename <id> <display name...> | clear-name <id>]";

export interface GptAccountExtensionDeps {
	/** Browser launcher for the browser login method; tests inject a recorder. */
	readonly openBrowser?: ((url: string) => void) | undefined;
}

function parseArgs(rawArgs: string): string[] {
	return rawArgs.trim().split(/\s+/).filter(Boolean);
}

function usage(ctx: ExtensionCommandContext): void {
	ctx.ui.notify(`Usage: /gpt-account ${USAGE_ACTIONS}`, "error");
}

async function showAccounts(ctx: ExtensionCommandContext): Promise<void> {
	const accounts = await getCredentialAccounts(ctx.modelRegistry.authStorage, CHATGPT_SUBSCRIPTION_PROVIDER_ID);
	const lines = ["ChatGPT Subscription OAuth accounts:"];
	if (accounts.length === 0) lines.push("  (none)");
	for (const account of accounts) {
		const states = [accountLabel(account), account.source, account.blocked ? "blocked" : "available"];
		if (account.pinned) states.push("pinned");
		lines.push(`  ${states.join(" | ")}`);
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

async function addAccount(ctx: ExtensionCommandContext, deps: GptAccountExtensionDeps): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/gpt-account add requires an interactive UI.", "error");
		return;
	}
	try {
		let receipt: AccountLoginReceipt | undefined;
		await ctx.modelRegistry.modelRuntime.login(CHATGPT_SUBSCRIPTION_PROVIDER_ID, "oauth", {
			...createExtensionLoginInteraction(ctx, {
				providerLabel: CHATGPT_SUBSCRIPTION_PROVIDER_LABEL,
				providerId: CHATGPT_SUBSCRIPTION_PROVIDER_ID,
				openBrowser: deps.openBrowser,
			}),
			onAccountCommitted: (committed) => {
				receipt = committed;
			},
		});
		emitProviderAccountsChanged(CHATGPT_SUBSCRIPTION_PROVIDER_ID);
		ctx.ui.notify("ChatGPT Subscription OAuth account added.", "info");
		await promptAccountDisplayName(ctx, receipt);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message === LOGIN_CANCELLED_MESSAGE) return;
		ctx.ui.notify(message, "error");
	}
}

async function removeAccount(ctx: ExtensionCommandContext, name: string | undefined): Promise<void> {
	if (!name) {
		usage(ctx);
		return;
	}
	await removeCredentialAccount(ctx.modelRegistry.authStorage, CHATGPT_SUBSCRIPTION_PROVIDER_ID, name);
	ctx.ui.notify(`Removed ChatGPT Subscription OAuth account '${name}'.`, "info");
}

async function pinAccount(ctx: ExtensionCommandContext, name: string | undefined): Promise<void> {
	if (!name) {
		usage(ctx);
		return;
	}
	await pinCredentialAccount(ctx.modelRegistry.authStorage, CHATGPT_SUBSCRIPTION_PROVIDER_ID, name);
	ctx.ui.notify(`Pinned ChatGPT Subscription OAuth account '${name}'.`, "info");
}

const STILL_BLOCKED_REASON: Record<string, string> = {
	auth_error: "the credential was rejected; sign in again to clear it",
	disabled: "the account is disabled until its credential is replaced",
	rate_limit: "another cooldown on it is still running",
};

/**
 * Lifts a usage-limit block the user knows is gone (the limit reset on the provider side), like
 * `/claude-account unblock` (senpi#4600). The lift is `unblockPooledAccount`, which clears only a
 * live account-level usage or rate-limit block and reports the MERGED state afterwards, so a lift
 * that leaves an auth block standing is never announced as "usable again".
 */
async function unblockAccount(ctx: ExtensionCommandContext, name: string | undefined): Promise<void> {
	if (!name) {
		ctx.ui.notify("Usage: /gpt-account unblock <id>", "error");
		return;
	}
	const accounts = await getCredentialAccounts(ctx.modelRegistry.authStorage, CHATGPT_SUBSCRIPTION_PROVIDER_ID);
	if (!accounts.some((candidate) => candidate.name === name)) {
		ctx.ui.notify(`ChatGPT Subscription OAuth account '${name}' does not exist.`, "error");
		return;
	}
	const outcome = await unblockPooledAccount(ctx.modelRegistry.authStorage, CHATGPT_SUBSCRIPTION_PROVIDER_ID, name);
	if (!outcome.lifted) {
		ctx.ui.notify(`ChatGPT Subscription OAuth account '${name}' has no usage block to lift.`, "info");
		return;
	}
	if (outcome.blocked) {
		const reason = outcome.blockedReason === undefined ? undefined : STILL_BLOCKED_REASON[outcome.blockedReason];
		ctx.ui.notify(
			`Lifted the usage block on ChatGPT Subscription OAuth account '${name}', but it is still blocked${
				reason === undefined ? "" : `: ${reason}`
			}.`,
			"warning",
		);
		return;
	}
	ctx.ui.notify(`Unblocked ChatGPT Subscription OAuth account '${name}'. The next turn may use it.`, "info");
}

export default function gptAccountExtension(pi: ExtensionAPI, deps: GptAccountExtensionDeps = {}): void {
	pi.registerCommand("gpt-account", {
		description: "List and manage ChatGPT Subscription OAuth accounts.",
		argumentHint: USAGE_ACTIONS,
		requiresArguments: false,
		handler: async (rawArgs, ctx) => {
			if (await accountDisplayNameCommand(ctx, CHATGPT_SUBSCRIPTION_PROVIDER_ID, rawArgs)) return;
			const args = parseArgs(rawArgs);
			const action = args[0] ?? "list";
			try {
				if (action === "list") {
					await showAccounts(ctx);
					return;
				}
				if (action === "add") {
					await addAccount(ctx, deps);
					return;
				}
				if (action === "remove") {
					await removeAccount(ctx, args[1]);
					return;
				}
				if (action === "unblock") {
					await unblockAccount(ctx, args[1]);
					return;
				}
				if (action === "pin" && args[1] !== "unpin") {
					await pinAccount(ctx, args[1]);
					return;
				}
				if (action === "unpin" || (action === "pin" && args[1] === "unpin")) {
					await pinCredentialAccount(ctx.modelRegistry.authStorage, CHATGPT_SUBSCRIPTION_PROVIDER_ID, null);
					ctx.ui.notify("Unpinned ChatGPT Subscription OAuth account.", "info");
					return;
				}
				usage(ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
