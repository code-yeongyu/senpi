import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../../../config.ts";
import { McpConfigValidationError } from "./config.ts";
import {
	getServerEndpointValidationError,
	type McpServerConfig,
	type RawConfig,
	validateConfig,
} from "./config-schema.ts";

type WritableMcpServer = NonNullable<RawConfig["mcpServers"]>[string];

export function getGlobalMcpConfigPath(agentDir = getAgentDir()): string {
	return join(agentDir, "mcp.json");
}

export function addGlobalMcpServer(name: string, server: McpServerConfig): string {
	const path = getGlobalMcpConfigPath();
	const config = readGlobalMcpConfig(path);
	const next: RawConfig = { ...config, mcpServers: { ...(config.mcpServers ?? {}), [name]: stripDefaults(server) } };
	writeValidatedConfig(path, next);
	return path;
}

export function setGlobalMcpServerEnabled(name: string, enabled: boolean): boolean {
	const path = getGlobalMcpConfigPath();
	const config = readGlobalMcpConfig(path);
	const existing = config.mcpServers?.[name];
	if (existing === undefined) return false;
	const next: RawConfig = {
		...config,
		mcpServers: { ...(config.mcpServers ?? {}), [name]: { ...existing, enabled } },
	};
	writeValidatedConfig(path, next);
	return true;
}

function readGlobalMcpConfig(path: string): RawConfig {
	if (!existsSync(path)) return {};
	const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
	assertValidConfig(raw);
	return raw as RawConfig;
}

function writeValidatedConfig(path: string, config: RawConfig): void {
	assertValidConfig(config);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function assertValidConfig(config: unknown): void {
	if (!validateConfig.Check(config)) {
		const error = Array.from(validateConfig.Errors(config))[0];
		throw new McpConfigValidationError(`Invalid MCP config: ${error?.message ?? "unknown validation error"}`);
	}
	const endpointError = getServerEndpointValidationError(config as RawConfig);
	if (endpointError) throw new McpConfigValidationError(`Invalid MCP config at ${endpointError}`);
}

function stripDefaults(server: McpServerConfig): WritableMcpServer {
	if (server.type === "http") return { type: "http", url: server.url ?? "" };
	return { type: "stdio", command: server.command ?? "", args: server.args };
}
