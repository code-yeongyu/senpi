// Skill-declared MCP servers (mcp.json sidecar or SKILL.md frontmatter) resolve
// with the trust of the skill that declared them (senpi#2345). Stdio children
// see only the SDK's allowlisted environment plus `env`, so `${VAR}` expansion
// decides which parent secrets a skill-chosen command can read:
// - a user-owned skill, or a project skill of a trusted project, expands stdio
//   values exactly like trusted mcp.json;
// - an untrusted project's skill keeps them literal;
// - a remote server from any skill keeps url/headers literal and never sends a
//   bearerTokenEnv variable, because the skill chose where the request goes.
// Each kept-literal or dropped value produces one warning naming the fix.

import { hashConfig, interpolateValue, McpConfigValidationError, normalizeServer } from "./config.ts";
import type { RawConfig, ResolvedMcpServer } from "./config-schema.ts";
import { inheritMcpSharingScope } from "./sharing-policy.ts";

type RawServer = NonNullable<RawConfig["mcpServers"]>[string];

export interface SkillServerSource {
	readonly skillName: string;
	/** A user-owned skill, or a project skill of a trusted project. */
	readonly trusted: boolean;
	readonly env?: Record<string, string | undefined> | undefined;
}

export interface ResolvedSkillServer {
	/** Absent when the declaration was rejected; the warning says why. */
	readonly server?: ResolvedMcpServer;
	readonly warning?: string;
}

const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)/g;
const OWN_CONFIG_FIX = "declare the server in your own mcp.json instead";

/**
 * Resolve a skill-declared MCP server. Exposure is forced to search with no
 * directTools so the catalog registers with ZERO active tools until the owning
 * skill loads (0 pre-load payload tokens); lifecycle stays lazy.
 */
export function resolveSkillMcpServer(
	name: string,
	raw: RawServer,
	sourcePath: string,
	source: SkillServerSource,
): ResolvedSkillServer {
	const label = `Skill '${source.skillName}' MCP server '${name}'`;
	const declared = declareForTrust(name, raw, label, source);
	if (declared.declaration === undefined) return { warning: declared.warnings.join(" ") };
	const config = { ...normalizeServer(declared.declaration), directTools: [], exposure: "search" as const };
	inheritMcpSharingScope(raw, declared.declaration);
	inheritMcpSharingScope(declared.declaration, config);
	const server: ResolvedMcpServer = {
		config,
		configHash: hashConfig(config),
		name,
		source: "skill",
		sourcePath,
		state: config.enabled ? "enabled" : "disabled",
		transport: config.type,
	};
	return declared.warnings.length === 0 ? { server } : { server, warning: declared.warnings.join(" ") };
}

function declareForTrust(
	name: string,
	raw: RawServer,
	label: string,
	source: SkillServerSource,
): { declaration?: RawServer; warnings: string[] } {
	if ((raw.type ?? (raw.url ? "http" : "stdio")) !== "stdio") return declareRemote(raw, label);
	if (!source.trusted) {
		const literal = [raw.command, raw.cwd, ...(raw.args ?? []), ...Object.values(raw.env ?? {})];
		const warning = literalWarning(
			label,
			literal,
			"stays literal because the skill comes from an untrusted project; trust the project or move the server into your own mcp.json to expand it.",
		);
		return { declaration: raw, warnings: warning === undefined ? [] : [warning] };
	}
	try {
		return {
			declaration: interpolateValue(raw, `mcp.mcpServers.${name}`, source.env ?? process.env) as RawServer,
			warnings: [],
		};
	} catch (error) {
		if (!(error instanceof McpConfigValidationError)) throw error;
		return { warnings: [`${label} skipped: ${error.message}`] };
	}
}

function declareRemote(raw: RawServer, label: string): { declaration: RawServer; warnings: string[] } {
	const warnings: string[] = [];
	const literal = literalWarning(
		label,
		[raw.url, ...Object.values(raw.headers ?? {})],
		`in url/headers stays literal: a skill-declared remote server never expands environment variables, because the skill chooses where they are sent; ${OWN_CONFIG_FIX}.`,
	);
	if (literal !== undefined) warnings.push(literal);
	const sendsBearer = raw.auth === "bearer" || (raw.auth === undefined && raw.bearerTokenEnv !== undefined);
	if (!sendsBearer || raw.bearerTokenEnv === undefined) return { declaration: raw, warnings };
	warnings.push(
		`${label}: bearerTokenEnv '${raw.bearerTokenEnv}' is ignored and no Authorization header is sent, because a skill-declared remote server must not send a parent environment variable to a server the skill chose; ${OWN_CONFIG_FIX}, where bearerTokenEnv keeps working.`,
	);
	const { bearerTokenEnv: _dropped, ...rest } = raw;
	return { declaration: { ...rest, auth: false }, warnings };
}

function literalWarning(label: string, values: readonly (string | undefined)[], reason: string): string | undefined {
	const names = new Set<string>();
	for (const value of values) {
		for (const match of value?.matchAll(ENV_REFERENCE) ?? []) names.add(`\${${match[1]}}`);
	}
	return names.size === 0 ? undefined : `${label}: ${[...names].join(", ")} ${reason}`;
}
