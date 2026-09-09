import {
	type CredentialAccountSummary,
	getCredentialAccounts,
	pinCredentialAccount,
	removeCredentialAccount,
} from "../../../credential-accounts.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../../types.ts";

function parseArgs(rawArgs: string): string[] {
	return rawArgs.trim().split(/\s+/).filter(Boolean);
}

function usage(ctx: ExtensionCommandContext): void {
	ctx.ui.notify("Usage: /account <provider> [list | pin <name> | unpin | remove <name>]", "error");
}

function statusOf(account: CredentialAccountSummary): string {
	const states = [account.name, account.source, account.blocked ? "blocked" : "available"];
	if (account.pinned) states.push("pinned");
	return states.join(" | ");
}

async function showAccounts(ctx: ExtensionCommandContext, provider: string): Promise<void> {
	const accounts = await getCredentialAccounts(ctx.modelRegistry.authStorage, provider);
	const lines = [`Credential accounts for ${provider}:`];
	if (accounts.length === 0) lines.push("  (none)");
	for (const account of accounts) lines.push(`  ${statusOf(account)}`);
	ctx.ui.notify(lines.join("\n"), "info");
}

/**
 * Provider-neutral `/account` command over the generic credential pool. The
 * existing `/claude-account` and Cursor account commands stay untouched; this
 * command is the one surface that works for every provider. Output carries
 * names and health only, never key material.
 */
export default function accountExtension(pi: ExtensionAPI): void {
	pi.registerCommand("account", {
		description: "List and manage credential accounts for any provider.",
		argumentHint: "<provider> [list | pin <name> | unpin | remove <name>]",
		handler: async (rawArgs, ctx) => {
			const args = parseArgs(rawArgs);
			const provider = args[0];
			if (provider === undefined) {
				usage(ctx);
				return;
			}
			const action = args[1] ?? "list";
			try {
				if (action === "list") {
					await showAccounts(ctx, provider);
					return;
				}
				if (action === "pin" && args[2] !== undefined) {
					await pinCredentialAccount(ctx.modelRegistry.authStorage, provider, args[2]);
					ctx.ui.notify(`Pinned ${provider} account '${args[2]}'.`, "info");
					return;
				}
				if (action === "unpin") {
					await pinCredentialAccount(ctx.modelRegistry.authStorage, provider, null);
					ctx.ui.notify(`Unpinned ${provider} account.`, "info");
					return;
				}
				if (action === "remove" && args[2] !== undefined) {
					await removeCredentialAccount(ctx.modelRegistry.authStorage, provider, args[2]);
					ctx.ui.notify(`Removed ${provider} account '${args[2]}'.`, "info");
					return;
				}
				usage(ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
