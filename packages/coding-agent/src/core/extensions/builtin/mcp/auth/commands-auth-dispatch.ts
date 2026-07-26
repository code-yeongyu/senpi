import type { ExtensionAPI, ExtensionCommandContext } from "../../../types.ts";
import { createMcpLogger } from "../log.ts";
import type { McpService } from "../service.ts";
import { type AuthCommandDeps, runAuth, runAuthComplete, runAuthStart, runLogout } from "./commands-auth.ts";

// Bridges the /mcp slash command to the pure auth flow runners in
// commands-auth.ts, sourcing config/agentDir/env from the running service.
export async function handleMcpAuthCommand(
	subcommand: string,
	args: readonly string[],
	ctx: ExtensionCommandContext,
	pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">,
	service: McpService,
): Promise<void> {
	const name = args[0] ?? "";
	const target = service.getAuthTarget(name);
	if (name.length === 0 || target === undefined) {
		ctx.ui.notify(`Unknown MCP server: ${name || "<missing>"}`, "error");
		return;
	}
	const deps: AuthCommandDeps = {
		agentDir: target.agentDir,
		callbackUrl: target.callbackUrl,
		config: target.config,
		env: target.env,
		hasUI: ctx.hasUI,
		logger: createMcpLogger(name),
		notify: (message, type) => ctx.ui.notify(message, type),
		onReconnect: async () => {
			try {
				await service.reconnectServer(name);
			} catch {
				// A needs_auth/degraded state after logout is expected; status shows it.
			}
			await service.attachSession({ type: "session_start", reason: "reload" }, ctx, pi).catch(() => undefined);
		},
		openBrowser: (url) => ctx.ui.notify(`Open this URL to authorize ${name}:\n${url.toString()}`),
		pending: service.getPendingAuth(),
		interactiveGuard: {
			begin: (serverName) => service.beginInteractiveAuth(serverName),
			end: (serverName) => service.endInteractiveAuth(serverName),
		},
		serverName: name,
	};
	if (subcommand === "auth") return runAuth(deps);
	if (subcommand === "auth-start") {
		await runAuthStart(deps);
		return;
	}
	if (subcommand === "auth-complete") {
		const redirect = args[1] ?? "";
		if (redirect.length === 0) {
			ctx.ui.notify(`Usage: /mcp auth-complete ${name} <redirect-url>`, "error");
			return;
		}
		return runAuthComplete(deps, redirect);
	}
	if (subcommand === "logout") return runLogout(deps);
	ctx.ui.notify(`Unknown MCP auth subcommand: ${subcommand}`, "error");
}
