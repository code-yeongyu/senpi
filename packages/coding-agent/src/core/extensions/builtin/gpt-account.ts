import type { AccountLoginReceipt } from "@earendil-works/pi-ai";
import { accountLabel } from "@earendil-works/pi-ai/auth/pool/slots";
import {
	getCredentialAccounts,
	pinCredentialAccount,
	removeCredentialAccount,
	resolveCredentialAccountSelector,
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
		"Usage: /gpt-account [add | remove <id> | pin <id|verified email|profile name> | unpin | rename <id> <display name...> | clear-name <id>]",
		"error",
	);
}

async function showAccounts(ctx: ExtensionCommandContext): Promise<void> {
	const accounts = await getCredentialAccounts(ctx.modelRegistry.authStorage, CHATGPT_SUBSCRIPTION_PROVIDER_ID);
	const lines = ["ChatGPT Subscription OAuth accounts:"];
	if (accounts.length === 0) lines.push("  (none)");
	for (const account of accounts) {
		const states = [
			accountLabel(account),
			account.source,
			account.authAction ?? (account.blocked ? "blocked" : "available"),
		];
		if (account.pinned) states.push("pinned");
		lines.push(`  ${states.join(" | ")}`);
		if (account.verifiedEmail) lines.push(`    verified email: ${account.verifiedEmail}`);
		if (account.workspaceHint) lines.push(`    workspace: …${account.workspaceHint}`);
		const selectors = [
			account.name,
			account.verifiedEmail,
			account.verifiedEmail?.includes("@") ? account.verifiedEmail.split("@", 1)[0] : undefined,
			account.displayName,
		].filter((candidate): candidate is string => candidate !== undefined);
		const usable = [...new Set(selectors)].filter((candidate) => {
			try {
				return resolveCredentialAccountSelector(accounts, candidate) === account.name;
			} catch (error) {
				if (error instanceof Error && error.message.startsWith("Ambiguous account selector")) return false;
				throw error;
			}
		});
		lines.push(`    pin with: ${usable.join(", ")}`);
		const remaining = account.expiresInMs;
		let expiry = "expiry unknown";
		if (account.expiresAt !== undefined && remaining !== undefined) {
			const absolute = new Date(account.expiresAt).toISOString();
			if (remaining === 0) {
				expiry = `expired ${absolute}`;
			} else {
				let duration: string;
				if (remaining >= 86_400_000) {
					duration = `${Math.ceil(remaining / 86_400_000)}d`;
				} else if (remaining >= 3_600_000) {
					duration = `${Math.ceil(remaining / 3_600_000)}h`;
				} else {
					duration = `${Math.ceil(remaining / 60_000)}m`;
				}
				expiry = `expires ${absolute} (${duration} left)`;
			}
		}
		const advice =
			account.authAction === "refresh-on-use"
				? "refreshes on next use"
				: account.authAction === "reauth-required"
					? "re-auth required: /gpt-account add"
					: account.authAction === "temporarily-unavailable"
						? "temporary cooldown"
						: account.authAction === "account-disabled"
							? "account disabled"
							: undefined;
		lines.push(`    ${expiry}`);
		if (advice) lines.push(`    ${advice}`);
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

async function pinAccount(ctx: ExtensionCommandContext, selector: string | undefined): Promise<void> {
	if (!selector) {
		usage(ctx);
		return;
	}
	const accounts = await getCredentialAccounts(ctx.modelRegistry.authStorage, CHATGPT_SUBSCRIPTION_PROVIDER_ID);
	const name = resolveCredentialAccountSelector(accounts, selector);
	await pinCredentialAccount(ctx.modelRegistry.authStorage, CHATGPT_SUBSCRIPTION_PROVIDER_ID, name);
	ctx.ui.notify(`Pinned ChatGPT Subscription OAuth account '${name}'.`, "info");
}

export default function gptAccountExtension(pi: ExtensionAPI, deps: GptAccountExtensionDeps = {}): void {
	pi.registerCommand("gpt-account", {
		description: "List and manage ChatGPT Subscription OAuth accounts.",
		argumentHint:
			"[add | remove <id> | pin <id|email|profile> | unpin | rename <id> <display name...> | clear-name <id>]",
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
				if (action === "pin" && args[1] !== "unpin") {
					await pinAccount(ctx, args.slice(1).join(" "));
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
