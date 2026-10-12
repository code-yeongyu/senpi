import { normalizeProviderId } from "@earendil-works/pi-ai";
import { accountLabel } from "@earendil-works/pi-ai/auth/pool/slots";
import {
	type CredentialAccountSummary,
	describeAccountHealth,
	getCredentialAccounts,
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

/** The command that logs an existing account in again: in place for ChatGPT, a fresh /login elsewhere. */
function reloginCommandFor(provider: string): (name: string) => string {
	return normalizeProviderId(provider) === "chatgpt-subscription"
		? (name) => `/gpt-account login ${name}`
		: (name) => `/login ${provider}, then /account ${provider} remove ${name}`;
}

function statusOf(account: CredentialAccountSummary, provider: string): string {
	const states = [accountLabel(account), account.source, describeAccountHealth(account, reloginCommandFor(provider))];
	for (const { model, until } of account.blockedModels ?? []) {
		states.push(`blocked for ${model} until ${new Date(until).toISOString()}`);
	}
	if (account.pinned) states.push("pinned");
	return states.join(" | ");
}

async function showAccounts(ctx: ExtensionCommandContext, provider: string): Promise<void> {
	const accounts = await getCredentialAccounts(ctx.modelRegistry.authStorage, provider);
	const lines = [`Credential accounts for ${provider}:`];
	if (accounts.length === 0) lines.push("  (none)");
	for (const account of accounts) lines.push(`  ${statusOf(account, provider)}`);
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
		requiresArguments: true,
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
