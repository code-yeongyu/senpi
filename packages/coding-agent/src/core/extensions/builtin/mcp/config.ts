import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TLocalizedValidationError } from "typebox/error";
import { CONFIG_DIR_NAME, getAgentDir } from "../../../../config.ts";
import { McpConfigValidationError } from "./config-error.ts";
import { hashConfig } from "./config-identity.ts";
import { interpolateValue } from "./config-interpolation.ts";
import { normalizeServer } from "./config-normalize.ts";
import { rememberMcpReferenceOrigins } from "./config-references.ts";
import {
	defaultSettings,
	getServerEndpointValidationError,
	type LoadMcpConfigOptions,
	type McpServerSource,
	type McpSettings,
	type RawConfig,
	type ResolvedMcpConfig,
	type ResolvedMcpServer,
	validateConfig,
} from "./config-schema.ts";
import { inheritMcpSharingScope } from "./sharing-policy.ts";

export { McpConfigValidationError } from "./config-error.ts";
export { mergeExtensionMcpServers, resolveExtensionMcpServer } from "./config-extension.ts";
export { hashConfig } from "./config-identity.ts";
export { interpolateValue } from "./config-interpolation.ts";
export { normalizeServer } from "./config-normalize.ts";

interface JsonReadResult {
	raw: unknown;
	diagnostic?: string;
}

const trustedEnv = process.env as Record<string, string | undefined>;

export function loadMcpConfig(options: LoadMcpConfigOptions): ResolvedMcpConfig {
	const agentDir = options.agentDir ?? getAgentDir();
	const env = options.env ?? trustedEnv;
	const globalPath = join(agentDir, "mcp.json");
	const projectPath = join(options.cwd, CONFIG_DIR_NAME, "mcp.json");
	const claudePath = join(options.cwd, ".mcp.json");
	const globalConfig = readTrustedConfig(globalPath, env);
	const projectRead = readConfigJson(projectPath, options.projectTrusted);
	const projectRaw = projectRead.raw;
	const preliminary = mergeConfigs(
		globalConfig,
		options.projectTrusted ? validateRaw(projectRaw, projectPath) : undefined,
	);
	const shouldImportClaude = preliminary.settings?.importConfigs?.includes("claude") === true;
	const claudeRead = shouldImportClaude ? readConfigJson(claudePath, options.projectTrusted) : { raw: undefined };
	const claudeRaw = claudeRead.raw;
	const sources = [
		{ config: globalConfig, path: globalPath, source: "global" as const, trusted: true },
		{
			config:
				options.projectTrusted && shouldImportClaude ? readTrustedConfig(claudePath, env, claudeRaw) : undefined,
			path: claudePath,
			source: "claude" as const,
			trusted: options.projectTrusted,
		},
		{
			config: options.projectTrusted ? readTrustedConfig(projectPath, env, projectRaw) : undefined,
			path: projectPath,
			source: "project" as const,
			trusted: options.projectTrusted,
		},
	];
	const merged = mergeConfigs(...sources.map((item) => item.config));
	const result: ResolvedMcpConfig = { diagnostics: [], servers: {}, settings: normalizeSettings(merged.settings) };
	for (const diagnostic of [projectRead.diagnostic, claudeRead.diagnostic]) {
		if (diagnostic) result.diagnostics.push(diagnostic);
	}

	for (const item of sources) {
		if (item.trusted && item.config?.mcpServers) {
			addTrustedServers(result, item.config.mcpServers, { source: item.source, sourcePath: item.path, agentDir });
			continue;
		}
		if (!item.trusted) {
			addUntrustedServers(
				result,
				readServerNames(item.source === "claude" ? claudeRaw : projectRaw),
				item.source,
				item.path,
			);
		}
	}
	return result;
}

export function visitSpawnableMcpServers(
	config: ResolvedMcpConfig,
	visit: (name: string, server: ResolvedMcpServer) => void,
): void {
	for (const [name, server] of Object.entries(config.servers)) {
		if (server.state === "enabled") {
			visit(name, server);
		}
	}
}

function readTrustedConfig(
	path: string,
	env: Record<string, string | undefined>,
	raw = readConfigJson(path, true).raw,
): RawConfig | undefined {
	const config = interpolateConfig(validateRaw(raw, path), env);
	const endpointError = config ? getServerEndpointValidationError(config) : undefined;
	if (endpointError) throw new McpConfigValidationError(`Invalid MCP config at ${endpointError}`);
	rememberMcpReferenceOrigins(config?.mcpServers, path);
	return config;
}

function readConfigJson(path: string, trusted: boolean): JsonReadResult {
	if (!existsSync(path)) return { raw: undefined };
	try {
		const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
		return { raw };
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		if (trusted) throw new McpConfigValidationError(`Invalid MCP config at ${path}: ${reason}`);
		return { raw: undefined, diagnostic: `Blocked untrusted MCP config at ${path}: invalid JSON (${reason})` };
	}
}

function validateRaw(raw: unknown, _path: string): RawConfig | undefined {
	if (raw === undefined) return undefined;
	if (validateConfig.Check(raw)) {
		const config = raw as RawConfig;
		const endpointError = getServerEndpointValidationError(config);
		if (endpointError) throw new McpConfigValidationError(`Invalid MCP config at ${endpointError}`);
		return config;
	}
	const error = Array.from(validateConfig.Errors(raw))[0];
	throw new McpConfigValidationError(`Invalid MCP config at ${formatErrorPath(error)}: ${formatErrorMessage(error)}`);
}

function formatErrorPath(error: TLocalizedValidationError): string {
	const trimmed = error.instancePath.replace(/^\//, "");
	return trimmed.length === 0 ? "$" : trimmed.split("/").map(decodePathPart).join(".");
}

function decodePathPart(part: string): string {
	return part.replace(/~1/g, "/").replace(/~0/g, "~");
}

function formatErrorMessage(error: TLocalizedValidationError): string {
	return error.message === "must be array" ? "Expected array" : error.message;
}

function mergeConfigs(...configs: (RawConfig | undefined)[]): RawConfig {
	const merged: RawConfig = {};
	for (const config of configs) {
		if (!config) continue;
		merged.settings = { ...(merged.settings ?? {}), ...(config.settings ?? {}) };
		merged.mcpServers = { ...(merged.mcpServers ?? {}), ...(config.mcpServers ?? {}) };
	}
	return merged;
}

function normalizeSettings(settings: RawConfig["settings"]): McpSettings {
	return { ...defaultSettings, ...settings };
}

function addTrustedServers(
	result: ResolvedMcpConfig,
	servers: NonNullable<RawConfig["mcpServers"]>,
	origin: { readonly source: McpServerSource; readonly sourcePath: string; readonly agentDir: string },
): void {
	for (const [name, server] of Object.entries(servers)) {
		const config = normalizeServer(server);
		inheritMcpSharingScope(server, config);
		result.servers[name] = {
			config,
			configHash: hashConfig(config, origin.agentDir),
			name,
			source: origin.source,
			sourcePath: origin.sourcePath,
			state: config.enabled ? "enabled" : "disabled",
			transport: config.type,
		};
	}
}

function addUntrustedServers(
	result: ResolvedMcpConfig,
	names: readonly string[],
	source: McpServerSource,
	sourcePath: string,
): void {
	for (const name of names) {
		const existing = result.servers[name];
		if (existing && existing.state !== "untrusted") {
			result.diagnostics.push(
				`Blocked untrusted ${source} MCP server '${name}' from shadowing trusted ${existing.source} server.`,
			);
			continue;
		}
		result.servers[name] = { name, source, sourcePath, state: "untrusted" };
	}
}

function readServerNames(raw: unknown): string[] {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
	const servers = (raw as { mcpServers?: unknown }).mcpServers;
	if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return [];
	return Object.keys(servers);
}

function interpolateConfig(
	config: RawConfig | undefined,
	env: Record<string, string | undefined>,
): RawConfig | undefined {
	const resolved = interpolateValue(config, "mcp", env) as RawConfig | undefined;
	for (const [name, raw] of Object.entries(config?.mcpServers ?? {})) {
		const server = resolved?.mcpServers?.[name];
		if (server !== undefined) inheritMcpSharingScope(raw, server);
	}
	return resolved;
}
