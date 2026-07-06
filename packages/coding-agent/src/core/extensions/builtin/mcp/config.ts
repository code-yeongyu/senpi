import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TLocalizedValidationError } from "typebox/error";
import { CONFIG_DIR_NAME, getAgentDir } from "../../../../config.ts";
import {
	defaultSettings,
	getServerEndpointValidationError,
	type LoadMcpConfigOptions,
	type McpServerConfig,
	type McpServerSource,
	type McpSettings,
	type RawConfig,
	type ResolvedMcpConfig,
	type ResolvedMcpServer,
	validateConfig,
} from "./config-schema.ts";

export class McpConfigValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpConfigValidationError";
	}
}

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
			addTrustedServers(result, item.config.mcpServers, item.source, item.path);
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
	return interpolateConfig(validateRaw(raw, path), env);
}

function readConfigJson(path: string, trusted: boolean): JsonReadResult {
	if (!existsSync(path)) return { raw: undefined };
	try {
		return { raw: JSON.parse(readFileSync(path, "utf-8")) as unknown };
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
	return { toolPrefix: settings?.toolPrefix ?? defaultSettings.toolPrefix, ...settings };
}

function addTrustedServers(
	result: ResolvedMcpConfig,
	servers: NonNullable<RawConfig["mcpServers"]>,
	source: McpServerSource,
	sourcePath: string,
): void {
	for (const [name, server] of Object.entries(servers)) {
		const config = normalizeServer(server);
		result.servers[name] = {
			config,
			configHash: hashConfig(config),
			name,
			source,
			sourcePath,
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

function normalizeServer(server: NonNullable<RawConfig["mcpServers"]>[string]): McpServerConfig {
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
		type,
		...server,
	};
}

function interpolateConfig(
	config: RawConfig | undefined,
	env: Record<string, string | undefined>,
): RawConfig | undefined {
	return interpolateValue(config, "mcp", env) as RawConfig | undefined;
}

function interpolateValue(value: unknown, path: string, env: Record<string, string | undefined>): unknown {
	if (typeof value === "string") return interpolateString(value, path, env);
	if (Array.isArray(value)) return value.map((item, index) => interpolateValue(item, `${path}.${index}`, env));
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) out[key] = interpolateValue(item, `${path}.${key}`, env);
		return out;
	}
	return value;
}

function interpolateString(value: string, path: string, env: Record<string, string | undefined>): string {
	if (value.trimStart().startsWith("!") || value.includes("$(")) {
		const displayPath = path.replace(/^mcp\./, "");
		throw new McpConfigValidationError(
			`MCP config interpolation rejected command substitution at ${displayPath}: config values may reference only environment variables for security; shell commands are never executed.`,
		);
	}
	return value.replace(
		/\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g,
		(_match, name: string, _fallback: string, fallbackValue: string | undefined) => {
			return env[name] ?? fallbackValue ?? "";
		},
	);
}

function hashConfig(config: McpServerConfig): string {
	return createHash("sha256").update(stableStringify(config)).digest("hex");
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (typeof value === "object" && value !== null) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
