import type { AccountLoginReceipt } from "@earendil-works/pi-ai";
import { accountLabel } from "@earendil-works/pi-ai/auth/pool/slots";
import {
	describeAccountHealth,
	getCredentialAccounts,
	pinCredentialAccount,
	removeCredentialAccount,
	replaceCredentialAccountMaterial,
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
		"Usage: /gpt-account [add | login <id> | remove <id> | pin <id> | unpin | rename <id> <display name...> | clear-name <id>]",
		"error",
	);
}

async function showAccounts(ctx: ExtensionCommandContext): Promise<void> {
	const accounts = await getCredentialAccounts(ctx.modelRegistry.authStorage, CHATGPT_SUBSCRIPTION_PROVIDER_ID);
	const lines = ["ChatGPT Subscription OAuth accounts:"];
	if (accounts.length === 0) lines.push("  (none)");
	for (const account of accounts) {
		const states = [accountLabel(account), account.source, describeAccountHealth(account, reloginCommand)];
		for (const { model, until } of account.blockedModels ?? []) {
			states.push(`usage limit on ${model} until ${new Date(until).toISOString()}`);
		}
		if (account.pinned) states.push("pinned");
		lines.push(`  ${states.join(" | ")}`);
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

function reloginCommand(name: string): string {
	return `/gpt-account login ${name}`;
}

async function runLogin(
	ctx: ExtensionCommandContext,
	deps: GptAccountExtensionDeps,
): Promise<AccountLoginReceipt | undefined> {
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
	return receipt;
}

async function addAccount(ctx: ExtensionCommandContext, deps: GptAccountExtensionDeps): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/gpt-account add requires an interactive UI.", "error");
		return;
	}
	try {
		const receipt = await runLogin(ctx, deps);
		emitProviderAccountsChanged(CHATGPT_SUBSCRIPTION_PROVIDER_ID);
		ctx.ui.notify("ChatGPT Subscription OAuth account added.", "info");
		await promptAccountDisplayName(ctx, receipt);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message === LOGIN_CANCELLED_MESSAGE) return;
		ctx.ui.notify(message, "error");
	}
}

/** Logs an existing account in again in place (senpi#3216): same id, display name and pin; its block clears. */
async function reloginAccount(
	ctx: ExtensionCommandContext,
	deps: GptAccountExtensionDeps,
	name: string | undefined,
): Promise<void> {
	if (!name) {
		usage(ctx);
		return;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("/gpt-account login requires an interactive UI.", "error");
		return;
	}
	const storage = ctx.modelRegistry.authStorage;
	const existing = await getCredentialAccounts(storage, CHATGPT_SUBSCRIPTION_PROVIDER_ID);
	const account = existing.find((candidate) => candidate.name === name);
	if (!account || account.source === "env") {
		ctx.ui.notify(
			`No ChatGPT Subscription OAuth account '${name}' to log in again; see /gpt-account for the ids.`,
			"error",
		);
		return;
	}
	try {
		const receipt = await runLogin(ctx, deps);
		if (receipt === undefined)
			throw new Error("The login finished, but the new credential could not be matched to an account.");
		await replaceCredentialAccountMaterial(storage, CHATGPT_SUBSCRIPTION_PROVIDER_ID, name, receipt.name);
		ctx.ui.notify(`Logged in again as ChatGPT Subscription OAuth account '${accountLabel(account)}'.`, "info");
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

export default function gptAccountExtension(pi: ExtensionAPI, deps: GptAccountExtensionDeps = {}): void {
	pi.registerCommand("gpt-account", {
		description: "List and manage ChatGPT Subscription OAuth accounts.",
		argumentHint:
			"[add | login <id> | remove <id> | pin <id> | unpin | rename <id> <display name...> | clear-name <id>]",
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
				if (action === "login") {
					await reloginAccount(ctx, deps, args[1]);
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
