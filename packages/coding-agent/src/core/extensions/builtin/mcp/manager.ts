import { type SelectItem, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "../../types.ts";
import { resolveAuthMode } from "./auth/context.ts";
import { updateMcpServerConfig } from "./config-edit.ts";
import type { McpServerConfig } from "./config-schema.ts";
import { collectAllPages } from "./expose/pagination.ts";
import { McpManagerView } from "./manager-view.ts";
import type { McpService } from "./service.ts";
import type { McpServerSnapshot } from "./service-types.ts";
import { buildMcpStatusRows, formatMcpStatus } from "./status.ts";

type McpManagerCommand = "test" | "reconnect" | "auth" | "logout";
type Notify = ExtensionCommandContext["ui"]["notify"];
type RunCommand = (
	command: McpManagerCommand,
	name: string,
	ctx: ExtensionCommandContext,
	notify?: Notify,
) => Promise<void>;
const EXPOSURES = ["auto", "direct", "search", "proxy"] as const;

export async function showMcpManager(
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	service: McpService,
	run: RunCommand,
): Promise<void> {
	const authAction = await ctx.ui.custom<{ command: "auth" | "logout"; name: string } | undefined>(
		(tui, theme, keybindings, done) => {
			const view = new McpManagerView(tui, theme, keybindings);
			void manage(view, ctx, pi, service, run).then(done, (error: unknown) => {
				done(undefined);
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			});
			return view;
		},
	);
	// The existing auth flow retains notices in the transcript; do not hide it behind a custom view.
	if (authAction) await run(authAction.command, authAction.name, ctx);
}

async function manage(
	view: McpManagerView,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	service: McpService,
	run: RunCommand,
): Promise<{ command: "auth" | "logout"; name: string } | undefined> {
	const subscribe = (listener: () => void): (() => void) => {
		let disconnect: Array<() => void> = [];
		const bind = (): void => {
			for (const stop of disconnect) stop();
			disconnect = service.getServerSnapshots(pi).flatMap((snapshot) => {
				const connection = service.getConnection(snapshot.name, pi);
				return connection ? [connection.onStateChange(listener)] : [];
			});
		};
		bind();
		const unregister = service.onMcpRegistrationChanged(() => {
			bind();
			listener();
		});
		return () => {
			unregister();
			for (const stop of disconnect) stop();
		};
	};
	for (;;) {
		const name = await view.menu(async () => {
			const rows = await buildMcpStatusRows(service.getServerSnapshots(pi), (server) =>
				service.getServerExposureStatus(server, pi),
			);
			return {
				title: "MCP servers",
				items: rows.map(({ snapshot, exposure }) => {
					const resources = service.getMcpResourceServers(pi).find((server) => server.server === snapshot.name);
					return {
						value: snapshot.name,
						label: snapshot.name,
						description: [
							snapshot.configState === "enabled" ? snapshot.lifecycleState : snapshot.configState,
							`${exposure.toolCount ?? "?"} tools`,
							...(resources ? [`${resources.resources.length} resources`] : []),
							exposure.mode ?? service.getAuthTarget(snapshot.name)?.config.exposure ?? "auto",
							snapshot.source ?? "unknown",
						].join(" · "),
					};
				}),
				empty: "No MCP servers configured. Add one with /mcp add <name> <command...|url>.",
				confirmLabel: "manage",
				cancelLabel: "close",
			};
		}, subscribe);
		if (name === undefined) return undefined;
		let message: string | undefined;
		for (;;) {
			const action = await view.menu(() => {
				const snapshot = service.getServerSnapshots(pi).find((server) => server.name === name);
				const config = service.getAuthTarget(name)?.config;
				return {
					title: `MCP server ${name}`,
					details: [snapshot?.lastError, message].filter(Boolean).join("\n") || undefined,
					items: snapshot ? serverActions(snapshot, config, service.getServerAuthStatus(name) === "oAuth") : [],
					empty: "This server is no longer configured.",
					confirmLabel: "select",
					cancelLabel: "back",
				};
			}, subscribe);
			if (action === undefined) break;
			const snapshot = service.getServerSnapshots(pi).find((server) => server.name === name);
			if (!snapshot) break;
			if (action === "auth" || action === "logout") return { command: action, name };
			message = undefined;
			try {
				if (action === "status") {
					const rows = await buildMcpStatusRows([snapshot], (server) =>
						service.getServerExposureStatus(server, pi),
					);
					await showText(view, `Details of ${name}`, formatMcpStatus("", rows).trim());
				} else if (action === "logs") {
					await showText(view, `Logs of ${name}`, service.getLogLines(name, 20).join("\n") || "(empty)");
				} else if (action === "tools") {
					const connection = service.getConnection(name, pi);
					if (connection?.state !== "connected") continue;
					const tools = await collectAllPages((cursor) =>
						connection.client.listTools(cursor === undefined ? {} : { cursor }, { timeout: 2000 }),
					);
					await view.menu(() => ({
						title: `Tools of ${name}`,
						items: tools.items.map((tool) => ({
							value: tool.name,
							label: tool.name,
							description: tool.description,
						})),
						empty: "The server offers no tools.",
						confirmLabel: "back",
						cancelLabel: "back",
					}));
				} else if (action === "enable" || action === "disable" || action === "exposure") {
					let exposure: McpServerConfig["exposure"] | undefined;
					if (action === "exposure") {
						const choice = await view.menu(() => ({
							title: `Exposure of ${name}`,
							items: EXPOSURES.map((value) => ({ value, label: value })),
							selected: service.getAuthTarget(name)?.config.exposure,
							confirmLabel: "save",
							cancelLabel: "back",
						}));
						exposure = EXPOSURES.find((value) => value === choice);
						if (exposure === undefined) continue;
					}
					if (!isWritable(snapshot) || !snapshot.sourcePath) continue;
					const patch = exposure === undefined ? { enabled: action === "enable" } : { exposure };
					if (!updateMcpServerConfig(snapshot.sourcePath, name, patch)) {
						message = "This server is no longer in its configuration file.";
						continue;
					}
					view.status(`MCP server ${name}`, "Applying configuration...");
					await service.attachSession({ type: "session_start", reason: "reload" }, ctx, pi);
					message = "Configuration saved.";
				} else if (action === "test" || action === "reconnect") {
					view.status(`MCP server ${name}`, action === "test" ? "Testing..." : "Reconnecting...");
					const notices: string[] = [];
					await run(action, name, ctx, (text) => notices.push(text));
					message = notices.join("\n");
				}
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
		}
	}
}

function isWritable(snapshot: McpServerSnapshot): boolean {
	return snapshot.configState !== "untrusted" && (snapshot.source === "global" || snapshot.source === "project");
}

function serverActions(
	snapshot: McpServerSnapshot,
	config: McpServerConfig | undefined,
	loggedIn: boolean,
): SelectItem[] {
	const items: SelectItem[] = [
		{ value: "status", label: "Details" },
		{ value: "logs", label: "Logs" },
	];
	if (snapshot.configState === "enabled") {
		if (snapshot.lifecycleState === "connected") items.push({ value: "tools", label: "Tools" });
		items.push({ value: "test", label: "Test connection" }, { value: "reconnect", label: "Reconnect" });
		if (config && resolveAuthMode(config) === "oauth") {
			items.push(
				loggedIn
					? { value: "logout", label: "Sign out", description: "deletes stored credentials" }
					: { value: "auth", label: "Sign in", description: "closes this view and opens authorization" },
			);
		}
	}
	if (isWritable(snapshot)) {
		items.push({
			value: snapshot.configState === "disabled" ? "enable" : "disable",
			label: snapshot.configState === "disabled" ? "Enable" : "Disable",
			description: `saved to ${snapshot.source} mcp.json`,
		});
		items.push({ value: "exposure", label: "Exposure", description: config?.exposure });
	}
	return items;
}

async function showText(view: McpManagerView, title: string, text: string): Promise<void> {
	await view.menu(() => ({
		title,
		items: wrapTextWithAnsi(text, Math.max(1, view.columns - 4)).map((label, index) => ({
			value: String(index),
			label,
		})),
		confirmLabel: "back",
		cancelLabel: "back",
	}));
}
