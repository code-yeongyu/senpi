import { createHash } from "node:crypto";
import type { McpServerConfig, McpServerDeclaration } from "./config-schema.ts";
import type { ServerConnectionOptions } from "./connection-types.ts";

const sessionDependent = new WeakSet<object>();
const sessionVariable = /(?:cwd|session|^PWD$|^OLDPWD$)/i;
const sessionTemplate = /\$\{[^}]*(?:cwd|session|PWD)[^}]*\}/i;

/** Preserve interpolation provenance without changing serialized config/cache identity. */
export function inheritMcpSharingScope(source: McpServerDeclaration, target: McpServerDeclaration): void {
	if (sessionDependent.has(source) || hasSessionValues(source)) sessionDependent.add(target);
}

function hasSessionValues(config: McpServerDeclaration, cwd?: string): boolean {
	const values = [config.command, ...(config.args ?? []), ...Object.values(config.env ?? {})];
	return (
		Object.keys(config.env ?? {}).some((key) => sessionVariable.test(key)) ||
		[...values, config.cwd].some((value) => value !== undefined && sessionTemplate.test(value)) ||
		(cwd !== undefined && values.some((value) => value?.includes(cwd)))
	);
}

export function shareable(config: McpServerConfig, cwd?: string): boolean {
	return config.type === "http" || (!sessionDependent.has(config) && !hasSessionValues(config, cwd));
}

/** Transport identity excludes per-owner exposure and idle/keep-alive policy. */
export function sharedMcpKey(options: ServerConnectionOptions, agentDir: string): string {
	const { config, env } = options;
	const bearer = config.bearerTokenEnv;
	const identity = {
		credentialIdentity: options.credentialIdentity,
		agentDir,
		name: options.serverName,
		type: config.type,
		url: config.type === "http" ? config.url : undefined,
		command: config.type === "stdio" ? config.command : undefined,
		args: config.type === "stdio" ? config.args : undefined,
		cwd: config.type === "stdio" ? (config.cwd ?? process.cwd()) : undefined,
		env: config.type === "stdio" ? { ...env, ...config.env } : undefined,
		headers: config.headers,
		auth: config.auth,
		oauth: config.oauth,
		bearer: bearer === undefined ? undefined : (env?.[bearer] ?? process.env[bearer]),
		connectTimeoutMs: config.connectTimeoutMs,
		logLevel: config.logLevel,
	};
	return createHash("sha256").update(stableJson(identity)).digest("hex");
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}
