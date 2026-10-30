import type { AccountLoginReceipt } from "@earendil-works/pi-ai";
import { accountLabel } from "@earendil-works/pi-ai/auth/pool/slots";
import {
	getCredentialAccounts,
	pinCredentialAccount,
	removeCredentialAccount,
	selectedOAuthAccount,
} from "../../../core/credential-accounts.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../types.ts";
import { accountDisplayNameCommand, promptAccountDisplayName } from "./account-display-name.ts";
import { emitProviderAccountsChanged } from "./anthropic-subscription/account-events.ts";
import { createExtensionLoginInteraction, LOGIN_CANCELLED_MESSAGE } from "./oauth-login-interaction.ts";

const CHATGPT_SUBSCRIPTION_PROVIDER_ID = "chatgpt-subscription";
const CHATGPT_SUBSCRIPTION_PROVIDER_LABEL = "ChatGPT Subscription OAuth";

export interface GptAccountExtensionDeps {
	/** Browser launcher for the browser login method; tests inject a recorder. */
	readonly openBrowser?: ((url: string) => void) | undefined;
}

function parseArgs(rawArgs: string): string[] {
	return rawArgs.trim().split(/\s+/).filter(Boolean);
}

function usage(ctx: ExtensionCommandContext): void {
	ctx.ui.notify(
		"Usage: /gpt-account [add | reauthorize <id> | signout <id> | remove <id> | pin <id> | unpin | rename <id> <display name...> | clear-name <id>]",
		"error",
	);
}

async function showAccounts(ctx: ExtensionCommandContext): Promise<void> {
	const activeName = ctx.modelRegistry.modelRuntime?.getActiveCredentialAccount?.(
		CHATGPT_SUBSCRIPTION_PROVIDER_ID,
		ctx.sessionManager.getSessionId(),
	);
	const accounts = await getCredentialAccounts(
		ctx.modelRegistry.authStorage,
		CHATGPT_SUBSCRIPTION_PROVIDER_ID,
		process.env,
		undefined,
		activeName,
	);
	const lines = ["ChatGPT Subscription OAuth accounts:"];
	if (accounts.length === 0) lines.push("  (none)");
	for (const account of accounts) {
		const availability = account.signedOut
			? "signed out"
			: account.paused
				? "paused"
				: account.planUsageEnabled === false
					? "plan usage not enabled: enable it or use an API key"
					: account.blocked
						? "blocked"
						: "available";
		const states = [accountLabel(account), account.source, availability];
		if (account.pinned) states.push("pinned");
		if (account.active) states.push("active");
		if (account.route) states.push(account.route === "siwc" ? "SIWC" : "legacy");
		if (!account.signedOut && account.planUsageEnabled === true) states.push("Using ChatGPT plan");
		lines.push(`  ${states.join(" | ")}`);
	}
	lines.push("Manage usage: https://chatgpt.com/settings/usage (ChatGPT Settings > Usage)");
	ctx.ui.notify(lines.join("\n"), "info");
}

async function addAccount(ctx: ExtensionCommandContext, deps: GptAccountExtensionDeps, name?: string): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/gpt-account add requires an interactive UI.", "error");
		return;
	}
	try {
		let receipt: AccountLoginReceipt | undefined;
		const reauthorize =
			name === undefined
				? undefined
				: selectedOAuthAccount(ctx.modelRegistry.authStorage, CHATGPT_SUBSCRIPTION_PROVIDER_ID, name);
		await ctx.modelRegistry.modelRuntime.login(
			CHATGPT_SUBSCRIPTION_PROVIDER_ID,
			"oauth",
			{
				...createExtensionLoginInteraction(ctx, {
					providerLabel: CHATGPT_SUBSCRIPTION_PROVIDER_LABEL,
					providerId: CHATGPT_SUBSCRIPTION_PROVIDER_ID,
					openBrowser: deps.openBrowser,
				}),
				onAccountCommitted: (committed) => {
					receipt = committed;
				},
			},
			reauthorize === undefined ? undefined : { reauthorize },
		);
		emitProviderAccountsChanged(CHATGPT_SUBSCRIPTION_PROVIDER_ID);
		ctx.ui.notify(
			name === undefined
				? "ChatGPT Subscription OAuth account added."
				: `ChatGPT Subscription OAuth account '${name}' reauthorized.`,
			"info",
		);
		if (name === undefined) await promptAccountDisplayName(ctx, receipt);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message === LOGIN_CANCELLED_MESSAGE) return;
		ctx.ui.notify(message, "error");
	}
}

async function signOutAccount(ctx: ExtensionCommandContext, name: string): Promise<void> {
	selectedOAuthAccount(ctx.modelRegistry.authStorage, CHATGPT_SUBSCRIPTION_PROVIDER_ID, name);
	const result = await ctx.modelRegistry.modelRuntime.logout(CHATGPT_SUBSCRIPTION_PROVIDER_ID, { slotId: name });
	emitProviderAccountsChanged(CHATGPT_SUBSCRIPTION_PROVIDER_ID);
	if (result?.status === "remote_revocation_unconfirmed") {
		ctx.ui.notify("remote revocation not confirmed; disconnect the app in ChatGPT Settings", "warning");
	} else {
		ctx.ui.notify(`Signed out ChatGPT Subscription OAuth account '${name}'.`, "info");
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

export default function gptAccountExtension(pi: ExtensionAPI, deps: GptAccountExtensionDeps = {}): void {
	pi.registerCommand("gpt-account", {
		description: "List and manage ChatGPT Subscription OAuth accounts.",
		argumentHint:
			"[add | reauthorize <id> | signout <id> | remove <id> | pin <id> | unpin | rename <id> <display name...> | clear-name <id>]",
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
				if (action === "reauthorize" && args[1]) {
					await addAccount(ctx, deps, args[1]);
					return;
				}
				if (action === "signout" && args[1]) {
					await signOutAccount(ctx, args[1]);
					return;
				}
				if (action === "remove") {
					await removeAccount(ctx, args[1]);
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
