import type { AccountLoginReceipt } from "@earendil-works/pi-ai";
import { accountLabel } from "@earendil-works/pi-ai/auth/pool/slots";
import { renameCredentialAccount } from "../../credential-accounts.ts";
import type { ExtensionCommandContext } from "../types.ts";
import { LOGIN_CANCELLED_MESSAGE } from "./oauth-login-interaction.ts";

/** Shared command grammar preserves spaces inside the display name. */
export async function accountDisplayNameCommand(
	ctx: ExtensionCommandContext,
	provider: string,
	rawArgs: string,
): Promise<boolean> {
	const [action, name, ...words] = rawArgs.trim().split(/\s+/);
	if (action !== "rename" && action !== "clear-name") return false;
	try {
		if (!name || (action === "clear-name" && words.length > 0)) {
			throw new Error("Usage: rename <id> <display name...> or clear-name <id>");
		}
		const displayName = action === "clear-name" ? null : rawArgs.trim().replace(/^\S+\s+\S+\s*/, "");
		await renameCredentialAccount(ctx.modelRegistry.authStorage, provider, name, displayName);
		ctx.ui.notify(
			`Account display name updated: ${accountLabel({ name, displayName: displayName ?? undefined })}.`,
			"info",
		);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
	return true;
}

/** Naming is a separate, optional operation after a successful login commit. */
export async function promptAccountDisplayName(
	ctx: ExtensionCommandContext,
	receipt: AccountLoginReceipt | undefined,
): Promise<void> {
	if (receipt?.origin !== "generated" || ctx.signal?.aborted) return;
	try {
		const answer = await ctx.ui.input(
			`Display name for account ${receipt.name} (optional)`,
			"Leave blank to keep the account ID",
			ctx.signal ? { signal: ctx.signal } : undefined,
		);
		if (answer === undefined || answer.trim() === "" || ctx.signal?.aborted) return;
		await renameCredentialAccount(ctx.modelRegistry.authStorage, receipt.providerId, receipt.name, answer);
		ctx.ui.notify(`Account display name: ${accountLabel({ name: receipt.name, displayName: answer })}.`, "info");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (ctx.signal?.aborted || message === LOGIN_CANCELLED_MESSAGE) return;
		ctx.ui.notify(`Account is saved, but its display name was not changed: ${message}`, "warning");
	}
}
