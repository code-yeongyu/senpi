import type { McpServerConfig, McpServerDeclaration, McpServerDeclaredConfig, RawConfig } from "./config-schema.ts";
import { MCP_STARTUP_RACE_MS } from "./startup-race.ts";

type LiteralDeclaration = Omit<McpServerDeclaration, "args" | "env" | "headers"> & {
	args?: string[];
	env?: Record<string, string>;
	headers?: Record<string, string>;
};

/** A declaration of plain strings normalizes to a resolved snapshot; one holding references stays declared. */
export function normalizeServer(server: LiteralDeclaration): McpServerConfig;
export function normalizeServer(server: NonNullable<RawConfig["mcpServers"]>[string]): McpServerDeclaredConfig;
export function normalizeServer(server: NonNullable<RawConfig["mcpServers"]>[string]): McpServerDeclaredConfig {
	const type = server.type ?? (server.url ? "http" : "stdio");
	return {
		args: server.args ?? [],
		connectTimeoutMs: server.connectTimeoutMs ?? 15_000,
		enabled: server.enabled ?? true,
		exposure: server.exposure ?? "auto",
		idleTimeoutMin: server.idleTimeoutMin ?? 10,
		lifecycle: server.lifecycle ?? "lazy",
		logLevel: server.logLevel ?? "info",
		requestTimeoutMs: server.requestTimeoutMs ?? 30_000,
		startupTimeoutMs: server.startupTimeoutMs ?? MCP_STARTUP_RACE_MS,
		type,
		...server,
	};
}
