import {
	getCredentialAccounts,
	pinCredentialAccount,
	removeCredentialAccount,
} from "../../../core/credential-accounts.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../types.ts";

const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

function parseArgs(rawArgs: string): string[] {
	return rawArgs.trim().split(/\s+/).filter(Boolean);
}

function usage(ctx: ExtensionCommandContext): void {
	ctx.ui.notify("Usage: /gpt-account [add | remove <name> | pin <name> | unpin]", "error");
}

function authEventMessage(event: unknown): string {
	if (event === null || typeof event !== "object") return "OpenAI Codex OAuth authentication update.";
	const value = event as Record<string, unknown>;
	if (value.type === "auth_url" && typeof value.url === "string") {
		return `Open this URL to authorize OpenAI Codex OAuth:\n${value.url}`;
	}
	if (value.type === "device_code" && typeof value.verificationUri === "string") {
		return `Open this URL to authorize OpenAI Codex OAuth:\n${value.verificationUri}`;
	}
	return typeof value.message === "string" ? value.message : "OpenAI Codex OAuth authentication update.";
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

async function addAccount(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/gpt-account add requires an interactive UI.", "error");
		return;
	}
	try {
		await ctx.modelRegistry.modelRuntime.login(OPENAI_CODEX_PROVIDER_ID, "oauth", {
			signal: ctx.signal,
			prompt: async (prompt) => {
				const answer = await ctx.ui.input(prompt.message);
				if (answer === undefined) throw new Error("Login cancelled");
				return answer;
			},
			notify: (event) => ctx.ui.notify(authEventMessage(event), "info"),
		});
		ctx.ui.notify("OpenAI Codex OAuth account added.", "info");
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
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

export default function gptAccountExtension(pi: ExtensionAPI): void {
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
					await addAccount(ctx);
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
