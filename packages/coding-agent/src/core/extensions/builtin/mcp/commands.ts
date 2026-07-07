import type { ExtensionAPI, ExtensionCommandContext } from "../../types.ts";
import { handleMcpAuthCommand } from "./auth/commands-auth-dispatch.ts";
import { addGlobalMcpServer, setGlobalMcpServerEnabled } from "./config-edit.ts";
import type { McpServerConfig } from "./config-schema.ts";
import { getMcpService } from "./service.ts";
import { buildMcpStatusRows, formatMcpStatus } from "./status.ts";

const SUBCOMMANDS = [
	"status",
	"add",
	"enable",
	"disable",
	"test",
	"logs",
	"reconnect",
	"auth",
	"auth-start",
	"auth-complete",
	"logout",
] as const;

const AUTH_SUBCOMMANDS = new Set(["auth", "auth-start", "auth-complete", "logout"]);

export function registerMcpCommands(pi: ExtensionAPI): void {
	pi.registerCommand("mcp", {
		description: "Inspect and manage MCP servers.",
		getArgumentCompletions: (prefix) =>
			SUBCOMMANDS.filter((item) => item.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (rawArgs, ctx) => {
			try {
				await handleMcpCommand(rawArgs, ctx, pi);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

async function handleMcpCommand(rawArgs: string, ctx: ExtensionCommandContext, pi: ExtensionAPI): Promise<void> {
	const args = splitCommandArgs(rawArgs);
	const subcommand = args[0] ?? "";
	if (subcommand === "") {
		await showPanel(ctx);
		return;
	}
	if (AUTH_SUBCOMMANDS.has(subcommand)) {
		await handleMcpAuthCommand(subcommand, args.slice(1), ctx, pi);
		return;
	}
	if (subcommand === "status") {
		await notifyStatus(ctx);
		return;
	}
	if (subcommand === "add") {
		await addServer(args.slice(1), ctx, pi);
		return;
	}
	if (subcommand === "enable" || subcommand === "disable") {
		await setServerEnabled(ctx, pi, args[1] ?? "", subcommand === "enable");
		return;
	}
	if (subcommand === "test") {
		await testServer(args[1] ?? "", ctx);
		return;
	}
	if (subcommand === "logs") {
		showLogs(args[1] ?? "", ctx);
		return;
	}
	if (subcommand === "reconnect") {
		await reconnectServer(args[1] ?? "", ctx, pi);
		return;
	}
	ctx.ui.notify(`Unknown /mcp subcommand: ${subcommand}`, "error");
}

async function showPanel(ctx: ExtensionCommandContext): Promise<void> {
	const text = await renderStatus("MCP servers");
	if (!ctx.hasUI) {
		ctx.ui.notify(text);
		return;
	}
	const choice = await ctx.ui.select(text, ["status", "logs <server>", "test <server>"]);
	if (choice === undefined) ctx.ui.notify(text);
}

async function notifyStatus(ctx: ExtensionCommandContext): Promise<void> {
	ctx.ui.notify(await renderStatus("MCP status"));
}

async function renderStatus(title: string): Promise<string> {
	const service = getMcpService();
	const rows = await buildMcpStatusRows(service.getServerSnapshots(), (name) => service.getServerExposureStatus(name));
	return formatMcpStatus(title, rows);
}

async function addServer(
	args: readonly string[],
	ctx: ExtensionCommandContext,
	pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">,
): Promise<void> {
	const [name, ...endpoint] = args;
	if (!name || endpoint.length === 0) {
		ctx.ui.notify("Usage: /mcp add <name> <command...|url>", "error");
		return;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("Cannot add MCP server without UI confirmation.", "error");
		return;
	}
	const server = parseServerConfig(endpoint);
	const confirmed = await ctx.ui.confirm("Add MCP server?", `${name}: ${endpoint.join(" ")}`);
	if (!confirmed) {
		ctx.ui.notify("MCP add cancelled", "warning");
		return;
	}
	addGlobalMcpServer(name, server);
	await getMcpService().attachSession({ type: "session_start", reason: "reload" }, ctx, pi);
	ctx.ui.notify(`Added MCP server ${name}`);
}

async function setServerEnabled(
	ctx: ExtensionCommandContext,
	pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">,
	name: string,
	enabled: boolean,
): Promise<void> {
	if (!ensureKnown(name, ctx)) return;
	if (!setGlobalMcpServerEnabled(name, enabled)) {
		ctx.ui.notify(`MCP server ${name} is not in the global config file`, "error");
		return;
	}
	ctx.ui.notify(`MCP server ${name} connecting`);
	await getMcpService().attachSession({ type: "session_start", reason: "reload" }, ctx, pi);
	ctx.ui.notify(`${enabled ? "Enabled" : "Disabled"} MCP server ${name}`);
}

async function testServer(name: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ensureKnown(name, ctx)) return;
	const connection = getMcpService().getConnection(name);
	if (connection === undefined) return;
	const started = Date.now();
	try {
		await connection.connect();
		const result = await connection.client.listTools({}, { timeout: 2000 });
		const elapsedMs = Date.now() - started;
		getMcpService().recordCall(name, elapsedMs, false);
		ctx.ui.notify(`MCP test ${name} ok (${elapsedMs}ms): ${result.tools.length} tools`);
	} catch (error) {
		const elapsedMs = Date.now() - started;
		getMcpService().recordCall(name, elapsedMs, true);
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`MCP test ${name} failed (${elapsedMs}ms): ${message}`, "error");
	}
}

function showLogs(name: string, ctx: ExtensionCommandContext): void {
	if (!ensureKnown(name, ctx)) return;
	const lines = getMcpService().getLogLines(name, 20);
	ctx.ui.notify(lines.length === 0 ? `MCP logs for ${name}: (empty)` : lines.join("\n"));
}

async function reconnectServer(
	name: string,
	ctx: ExtensionCommandContext,
	pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">,
): Promise<void> {
	if (!ensureKnown(name, ctx)) return;
	try {
		const service = getMcpService();
		await service.reconnectServer(name);
		await service.attachSession({ type: "session_start", reason: "reload" }, ctx, pi);
		ctx.ui.notify(`MCP reconnect ${name} connected`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`MCP reconnect ${name} failed: ${message}`, "error");
	}
}

function ensureKnown(name: string, ctx: ExtensionCommandContext): boolean {
	if (
		name.length > 0 &&
		getMcpService()
			.getServerSnapshots()
			.some((snapshot) => snapshot.name === name)
	)
		return true;
	const known = getMcpService()
		.getServerSnapshots()
		.map((snapshot) => snapshot.name)
		.join(", ");
	ctx.ui.notify(`Unknown MCP server: ${name || "<missing>"}\nKnown MCP servers: ${known || "(none)"}`, "error");
	return false;
}

function parseServerConfig(endpoint: readonly string[]): McpServerConfig {
	const first = endpoint[0] ?? "";
	if (/^https?:\/\//.test(first)) {
		return baseServer({ type: "http", url: first });
	}
	return baseServer({ type: "stdio", command: first, args: endpoint.slice(1) });
}

function baseServer(endpoint: Pick<McpServerConfig, "type"> & Partial<McpServerConfig>): McpServerConfig {
	return {
		args: [],
		connectTimeoutMs: 15_000,
		enabled: true,
		exposure: "auto",
		idleTimeoutMin: 10,
		lifecycle: "lazy",
		logLevel: "info",
		requestTimeoutMs: 30_000,
		...endpoint,
	};
}

function splitCommandArgs(raw: string): string[] {
	const matches = raw.match(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|[^\s]+/g) ?? [];
	return matches.map((part) => part.replace(/^["']|["']$/g, "").replace(/\\(["'])/g, "$1"));
}
