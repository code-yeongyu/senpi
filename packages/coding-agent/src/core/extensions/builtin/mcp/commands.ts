import { noticeEntryRenderer } from "../../notice/index.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../../types.ts";
import { handleMcpAuthCommand } from "./auth/commands-auth-dispatch.ts";
import { addGlobalMcpServer, setGlobalMcpServerEnabled } from "./config-edit.ts";
import type { McpServerConfig } from "./config-schema.ts";
import { showMcpManager } from "./manager.ts";
import { getMcpService } from "./service.ts";
import { MCP_STARTUP_RACE_MS } from "./startup-race.ts";
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
type Notify = ExtensionCommandContext["ui"]["notify"];

export function registerMcpCommands(
	pi: ExtensionAPI,
	service = getMcpService(),
	pendingAttach: () => Promise<void> | undefined = () => undefined,
): void {
	pi.registerEntryRenderer(
		"mcp-auth",
		noticeEntryRenderer<string>((entry) =>
			typeof entry.data === "string" ? { title: "MCP authorization", why: entry.data } : undefined,
		),
	);
	pi.registerCommand("mcp", {
		description: "Inspect and manage MCP servers.",
		getArgumentCompletions: (prefix) =>
			SUBCOMMANDS.filter((item) => item.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (rawArgs, ctx) => {
			try {
				// Startup attach no longer blocks the first frame, so /mcp can be reached while it is still
				// in flight. Every subcommand reports or mutates attached state, so wait for the single
				// in-flight attach rather than rendering a half-connected snapshot.
				await pendingAttach();
				await handleMcpCommand(splitCommandArgs(rawArgs), ctx, pi, service);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}

async function handleMcpCommand(
	args: readonly string[],
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	service: ReturnType<typeof getMcpService>,
	notify?: Notify,
): Promise<void> {
	const subcommand = args[0] ?? "";
	if (subcommand === "") {
		if (!ctx.hasUI || ctx.mode !== "tui") {
			ctx.ui.notify(await renderStatus("MCP servers", pi, service));
		} else {
			await showMcpManager(ctx, pi, service, (command, name, commandCtx, commandNotify) =>
				handleMcpCommand([command, name], commandCtx, pi, service, commandNotify),
			);
		}
		return;
	}
	if (AUTH_SUBCOMMANDS.has(subcommand)) {
		await handleMcpAuthCommand(subcommand, args.slice(1), ctx, pi, service);
		return;
	}
	if (subcommand === "status") {
		await notifyStatus(ctx, pi, service);
		return;
	}
	if (subcommand === "add") {
		await addServer(args.slice(1), ctx, pi, service);
		return;
	}
	if (subcommand === "enable" || subcommand === "disable") {
		await setServerEnabled(ctx, pi, service, args[1] ?? "", subcommand === "enable");
		return;
	}
	if (subcommand === "test") {
		await testServer(args[1] ?? "", ctx, pi, service, notify);
		return;
	}
	if (subcommand === "logs") {
		showLogs(args[1] ?? "", ctx, pi, service);
		return;
	}
	if (subcommand === "reconnect") {
		await reconnectServer(args[1] ?? "", ctx, pi, service, notify);
		return;
	}
	ctx.ui.notify(`Unknown /mcp subcommand: ${subcommand}`, "error");
}

type McpCommandService = ReturnType<typeof getMcpService>;

async function notifyStatus(ctx: ExtensionCommandContext, pi: object, service: McpCommandService): Promise<void> {
	ctx.ui.notify(await renderStatus("MCP status", pi, service));
}

/** Only the servers this session declares, never a peer's (senpi#3001). */
async function renderStatus(title: string, pi: object, service: McpCommandService): Promise<string> {
	const rows = await buildMcpStatusRows(service.getServerSnapshots(pi), (name) =>
		service.getServerExposureStatus(name, pi),
	);
	return formatMcpStatus(title, rows);
}

async function addServer(
	args: readonly string[],
	ctx: ExtensionCommandContext,
	pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">,
	service: McpCommandService,
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
	await service.attachSession({ type: "session_start", reason: "reload" }, ctx, pi);
	ctx.ui.notify(`Added MCP server ${name}`);
}

async function setServerEnabled(
	ctx: ExtensionCommandContext,
	pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">,
	service: McpCommandService,
	name: string,
	enabled: boolean,
): Promise<void> {
	if (!ensureKnown(name, ctx, pi, service)) return;
	if (!setGlobalMcpServerEnabled(name, enabled)) {
		ctx.ui.notify(`MCP server ${name} is not in the global config file`, "error");
		return;
	}
	ctx.ui.notify(`MCP server ${name} connecting`);
	await service.attachSession({ type: "session_start", reason: "reload" }, ctx, pi);
	ctx.ui.notify(`${enabled ? "Enabled" : "Disabled"} MCP server ${name}`);
}

async function testServer(
	name: string,
	ctx: ExtensionCommandContext,
	pi: object,
	service: McpCommandService,
	notify: Notify = (text, type) => ctx.ui.notify(text, type),
): Promise<void> {
	if (!ensureKnown(name, ctx, pi, service, notify)) return;
	const connection = service.getConnection(name, pi);
	if (connection === undefined) {
		notify(`MCP server ${name} has no connection for this session`, "error");
		return;
	}
	const started = Date.now();
	try {
		await connection.connect();
		const result = await connection.client.listTools({}, { timeout: 2000 });
		const elapsedMs = Date.now() - started;
		service.recordCall(name, elapsedMs, false);
		notify(`MCP test ${name} ok (${elapsedMs}ms): ${result.tools.length} tools`);
	} catch (error) {
		const elapsedMs = Date.now() - started;
		service.recordCall(name, elapsedMs, true);
		const message = error instanceof Error ? error.message : String(error);
		notify(`MCP test ${name} failed (${elapsedMs}ms): ${message}`, "error");
	}
}

function showLogs(name: string, ctx: ExtensionCommandContext, pi: object, service: McpCommandService): void {
	if (!ensureKnown(name, ctx, pi, service)) return;
	const lines = service.getLogLines(name, 20);
	ctx.ui.notify(lines.length === 0 ? `MCP logs for ${name}: (empty)` : lines.join("\n"));
}

async function reconnectServer(
	name: string,
	ctx: ExtensionCommandContext,
	pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">,
	service: McpCommandService,
	notify: Notify = (text, type) => ctx.ui.notify(text, type),
): Promise<void> {
	if (!ensureKnown(name, ctx, pi, service, notify)) return;
	try {
		await service.reconnectServer(name);
		await service.attachSession({ type: "session_start", reason: "reload" }, ctx, pi);
		notify(`MCP reconnect ${name} connected`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		notify(`MCP reconnect ${name} failed: ${message}`, "error");
	}
}

function ensureKnown(
	name: string,
	ctx: ExtensionCommandContext,
	pi: object,
	service: McpCommandService,
	notify: Notify = (text, type) => ctx.ui.notify(text, type),
): boolean {
	const snapshots = service.getServerSnapshots(pi);
	if (name.length > 0 && snapshots.some((snapshot) => snapshot.name === name)) return true;
	const known = snapshots.map((snapshot) => snapshot.name).join(", ");
	notify(`Unknown MCP server: ${name || "<missing>"}\nKnown MCP servers: ${known || "(none)"}`, "error");
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
		startupTimeoutMs: MCP_STARTUP_RACE_MS,
		...endpoint,
	};
}

function splitCommandArgs(raw: string): string[] {
	const matches = raw.match(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|[^\s]+/g) ?? [];
	return matches.map((part) => part.replace(/^["']|["']$/g, "").replace(/\\(["'])/g, "$1"));
}
