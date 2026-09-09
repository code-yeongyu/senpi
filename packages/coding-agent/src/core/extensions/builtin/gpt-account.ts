import {
	getCredentialAccounts,
	pinCredentialAccount,
	removeCredentialAccount,
} from "../../../core/credential-accounts.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../types.ts";
import { emitProviderAccountsChanged } from "./claude-sdk-oauth/account-events.ts";
import { createExtensionLoginInteraction, LOGIN_CANCELLED_MESSAGE } from "./oauth-login-interaction.ts";

const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
const OPENAI_CODEX_PROVIDER_LABEL = "OpenAI Codex OAuth";

export interface GptAccountExtensionDeps {
	/** Browser launcher for the browser login method; tests inject a recorder. */
	readonly openBrowser?: ((url: string) => void) | undefined;
}

function parseArgs(rawArgs: string): string[] {
	return rawArgs.trim().split(/\s+/).filter(Boolean);
}

function usage(ctx: ExtensionCommandContext): void {
	ctx.ui.notify("Usage: /gpt-account [add | remove <name> | pin <name> | unpin]", "error");
}

async function showAccounts(ctx: ExtensionCommandContext): Promise<void> {
	const accounts = await getCredentialAccounts(ctx.modelRegistry.authStorage, OPENAI_CODEX_PROVIDER_ID);
	const lines = ["OpenAI Codex OAuth accounts:"];
	if (accounts.length === 0) lines.push("  (none)");
	for (const account of accounts) {
		const states = [account.name, account.source, account.blocked ? "blocked" : "available"];
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
		await ctx.modelRegistry.modelRuntime.login(
			OPENAI_CODEX_PROVIDER_ID,
			"oauth",
			createExtensionLoginInteraction(ctx, {
				providerLabel: OPENAI_CODEX_PROVIDER_LABEL,
				openBrowser: deps.openBrowser,
			}),
		);
		emitProviderAccountsChanged(OPENAI_CODEX_PROVIDER_ID);
		ctx.ui.notify("OpenAI Codex OAuth account added.", "info");
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
	await removeCredentialAccount(ctx.modelRegistry.authStorage, OPENAI_CODEX_PROVIDER_ID, name);
	ctx.ui.notify(`Removed OpenAI Codex OAuth account '${name}'.`, "info");
}

async function pinAccount(ctx: ExtensionCommandContext, name: string | undefined): Promise<void> {
	if (!name) {
		usage(ctx);
		return;
	}
	await pinCredentialAccount(ctx.modelRegistry.authStorage, OPENAI_CODEX_PROVIDER_ID, name);
	ctx.ui.notify(`Pinned OpenAI Codex OAuth account '${name}'.`, "info");
}

export default function gptAccountExtension(pi: ExtensionAPI, deps: GptAccountExtensionDeps = {}): void {
	pi.registerCommand("gpt-account", {
		description: "List and manage OpenAI Codex OAuth accounts.",
		argumentHint: "[add | remove <name> | pin <name> | unpin]",
		handler: async (rawArgs, ctx) => {
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
					await pinAccount(ctx, args[1]);
					return;
				}
				if (action === "unpin" || (action === "pin" && args[1] === "unpin")) {
					await pinCredentialAccount(ctx.modelRegistry.authStorage, OPENAI_CODEX_PROVIDER_ID, null);
					ctx.ui.notify("Unpinned OpenAI Codex OAuth account.", "info");
					return;
				}
				usage(ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
