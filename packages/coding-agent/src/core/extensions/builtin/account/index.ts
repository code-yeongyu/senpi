import { accountLabel } from "@earendil-works/pi-ai/auth/pool/slots";
import {
	type CredentialAccountDetail,
	getCredentialAccountDetails,
	pinCredentialAccount,
	removeCredentialAccount,
} from "../../../credential-accounts.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../../types.ts";
import { accountDisplayNameCommand } from "../account-display-name.ts";

function parseArgs(rawArgs: string): string[] {
	return rawArgs.trim().split(/\s+/).filter(Boolean);
}

function usage(ctx: ExtensionCommandContext): void {
	ctx.ui.notify(
		"Usage: /account <provider> [list | pin <id> | unpin | remove <id> | rename <id> <display name...> | clear-name <id>]",
		"error",
	);
}

const BLOCK_REASON_LABELS: Record<NonNullable<CredentialAccountDetail["blockReason"]>, string> = {
	auth_error: "log in again",
	account_disabled: "account disabled",
	rate_limit: "rate limited",
};

function statusOf(account: CredentialAccountDetail): string {
	const health = account.blocked
		? account.blockReason === undefined
			? "blocked"
			: `blocked (${BLOCK_REASON_LABELS[account.blockReason]})`
		: "available";
	const states = [
		accountLabel(account),
		...(account.email === undefined ? [] : [account.email]),
		account.source,
		health,
	];
	if (account.pinned) states.push("pinned");
	return states.join(" | ");
}

async function showAccounts(ctx: ExtensionCommandContext, provider: string): Promise<void> {
	const accounts = await getCredentialAccountDetails(ctx.modelRegistry.authStorage, provider);
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
		argumentHint:
			"<provider> [list | pin <id> | unpin | remove <id> | rename <id> <display name...> | clear-name <id>]",
		handler: async (rawArgs, ctx) => {
			const args = parseArgs(rawArgs);
			const provider = args[0];
			if (provider === undefined) {
				usage(ctx);
				return;
			}
			if (await accountDisplayNameCommand(ctx, provider, rawArgs.trim().replace(/^\S+\s*/, ""))) return;
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
