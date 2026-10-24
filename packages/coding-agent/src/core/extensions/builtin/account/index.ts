import { accountLabel } from "@earendil-works/pi-ai/auth/pool/slots";
import { resetCredentialAccount } from "../../../credential-account-reset.ts";
import {
	type CredentialAccountSummary,
	getCredentialAccounts,
	pinCredentialAccount,
	removeCredentialAccount,
	renameCredentialAccount,
} from "../../../credential-accounts.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../../types.ts";
import { accountDisplayNameCommand } from "../account-display-name.ts";

function parseArgs(rawArgs: string): string[] {
	return rawArgs.trim().split(/\s+/).filter(Boolean);
}

function usage(ctx: ExtensionCommandContext): void {
	ctx.ui.notify(
		"Usage: /account <provider> [list | pin <id> | unpin | reset <id> | remove <id> | rename <id> <display name...> | clear-name <id>]",
		"error",
	);
}

function statusOf(account: CredentialAccountSummary): string {
	const availability = account.unused
		? "unused (other login kind; switch with /login)"
		: account.blocked
			? "blocked"
			: "available";
	const states = [accountLabel(account), account.source, availability];
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
	for (const account of accounts) lines.push(`  ${statusOf(account)}`);
	ctx.ui.notify(lines.join("\n"), "info");
}

async function manageAnthropicAccounts(ctx: ExtensionCommandContext): Promise<void> {
	const storage = ctx.modelRegistry.authStorage;
	while (true) {
		const accounts = await getCredentialAccounts(storage, "anthropic");
		if (accounts.length === 0) {
			ctx.ui.notify("No Anthropic accounts found. Use /login to add an account.", "info");
			return;
		}
		const choices = accounts.map((account, index) => `${index + 1}. ${statusOf(account)}`);
		const selected = await ctx.ui.select("Anthropic accounts", [...choices, "Back"], { signal: ctx.signal });
		if (selected === undefined || selected === "Back") return;
		const index = choices.indexOf(selected);
		if (index === -1) return;
		const account = accounts[index];
		if (!account) return;
		const action = await ctx.ui.select(
			statusOf(account),
			[account.pinned ? "Unpin" : "Pin", "Rename", "Remove", "Back"],
			{ signal: ctx.signal },
		);
		if (action === undefined || action === "Back") continue;
		try {
			if (action === "Pin" || action === "Unpin") {
				await pinCredentialAccount(storage, "anthropic", action === "Pin" ? account.name : null);
				ctx.ui.notify(`${action === "Pin" ? "Pinned" : "Unpinned"} Anthropic account.`, "info");
			} else if (action === "Rename") {
				const displayName = await ctx.ui.input("Display name", account.displayName ?? account.name, {
					signal: ctx.signal,
				});
				if (displayName === undefined) continue;
				await renameCredentialAccount(storage, "anthropic", account.name, displayName.trim() || null);
				ctx.ui.notify("Renamed Anthropic account.", "info");
			} else if (action === "Remove") {
				const confirmed = await ctx.ui.confirm(
					"Remove Anthropic account",
					`Remove ${account.displayName ?? account.name}? This cannot be undone.`,
					{ signal: ctx.signal },
				);
				if (!confirmed) continue;
				await removeCredentialAccount(storage, "anthropic", account.name);
				ctx.ui.notify("Removed Anthropic account.", "info");
			}
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	}
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
			"<provider> [list | pin <id> | unpin | reset <id> | remove <id> | rename <id> <display name...> | clear-name <id>]",
		getArgumentCompletions: (prefix) => {
			const match = /^(\S+)\s+(\S*)$/.exec(prefix.trimStart());
			if (!match) {
				return "anthropic".startsWith(prefix) ? [{ value: "anthropic", label: "anthropic" }] : null;
			}
			const [, provider, actionPrefix] = match;
			const actions = ["list", "pin", "unpin", "reset", "remove", "rename", "clear-name"];
			const items = actions
				.filter((action) => action.startsWith(actionPrefix ?? ""))
				.map((action) => ({ value: `${provider} ${action}`, label: action }));
			return items.length > 0 ? items : null;
		},
		handler: async (rawArgs, ctx) => {
			const args = parseArgs(rawArgs);
			const provider = args[0];
			if (provider === undefined) {
				usage(ctx);
				return;
			}
			if (provider === "anthropic" && args.length === 1 && ctx.hasUI && ctx.mode === "tui") {
				await manageAnthropicAccounts(ctx);
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
				if (action === "reset" && args[2] !== undefined) {
					await resetCredentialAccount(ctx.modelRegistry.authStorage, provider, args[2]);
					ctx.ui.notify(
						`Cleared the cooldown on ${provider} account '${args[2]}'; the next request tries it again.`,
						"info",
					);
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
