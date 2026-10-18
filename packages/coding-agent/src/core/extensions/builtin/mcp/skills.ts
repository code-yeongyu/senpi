// skills-carry-MCP sidecar loader (todo 37).
//
// Skills can ship MCP servers two ways: an `mcp.json` sidecar next to SKILL.md
// (Amp-compatible: a map of serverName -> {command/args/env | url/headers} plus
// an optional includeTools glob list, optionally wrapped in `mcpServers`), or a
// `mcp:` block in SKILL.md frontmatter. The sidecar wins when both exist.
// Declared servers register LAZY with tools hidden (0 pre-load payload tokens,
// enforced by resolveSkillMcpServer forcing search mode with no directTools);
// loading a skill (a `/skill:<name>` command or the model reading its SKILL.md)
// reveals the union of its includeTools matches for the session. The same
// server declared by multiple skills union-merges includeTools; a name
// collision with a system-configured server is resolved system-wins at
// registration (service.attachSkillMcpServers). There is no reliable unload
// signal, so revealed tools stay active for the session.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter } from "../../../../utils/frontmatter.ts";
import type { SourceScope } from "../../../source-info.ts";
import type { RawConfig } from "./config-schema.ts";

type RawServer = NonNullable<RawConfig["mcpServers"]>[string];

export interface SkillLike {
	readonly name: string;
	readonly filePath: string;
	readonly baseDir: string;
	readonly sourceInfo?: { readonly scope: SourceScope };
}

/** A declared server as registered: the first declaring skill's config and where that skill came from. */
export interface SkillServerRegistration {
	raw: RawServer & { includeTools?: string[] };
	sourcePath: string;
	skillName: string;
	scope: SourceScope | undefined;
}

interface SkillServerDecl extends SkillServerRegistration {
	/** skill name -> includeTools globs declared by that skill (default all). */
	includeToolsBySkill: Map<string, string[]>;
}

export interface SkillMcpDeclarations {
	servers: Map<string, SkillServerDecl>;
	warnings: string[];
}

export function parseSkillMcpDeclarations(skills: readonly SkillLike[]): SkillMcpDeclarations {
	const servers = new Map<string, SkillServerDecl>();
	const warnings: string[] = [];
	for (const skill of skills) {
		const { declared, sourcePath, warning } = readSkillServers(skill);
		if (warning !== undefined) warnings.push(warning);
		for (const [name, raw] of Object.entries(declared)) {
			const globs = normalizeGlobs(raw.includeTools);
			const existing = servers.get(name);
			if (existing === undefined) {
				servers.set(name, {
					includeToolsBySkill: new Map([[skill.name, globs]]),
					raw,
					scope: skill.sourceInfo?.scope,
					skillName: skill.name,
					sourcePath,
				});
				continue;
			}
			// Same server from multiple skills: first config wins, includeTools
			// union-merge per skill (revealed together once any owner loads).
			existing.includeToolsBySkill.set(skill.name, globs);
		}
	}
	return { servers, warnings };
}

type SkillServers = {
	declared: Record<string, RawServer & { includeTools?: string[] }>;
	sourcePath: string;
	warning?: string;
};

/** Parsed declarations per skill file, reused while the sidecar and the skill file are unchanged on disk. */
const skillServersCache = new Map<string, { readonly key: string; readonly servers: SkillServers }>();

function fileStamp(path: string): string {
	try {
		const stat = statSync(path);
		return `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;
	} catch {
		return "missing";
	}
}

/**
 * Called for every skill on every turn (before_agent_start), so re-reading and re-parsing each
 * SKILL.md stalled each turn; the stat key keeps edits on disk visible on the next turn.
 */
function readSkillServers(skill: SkillLike): SkillServers {
	const sidecarPath = join(skill.baseDir, "mcp.json");
	const key = `${fileStamp(sidecarPath)}|${fileStamp(skill.filePath)}`;
	const cached = skillServersCache.get(skill.filePath);
	if (cached?.key === key) return cached.servers;
	const servers = readSkillServersFromDisk(skill);
	skillServersCache.set(skill.filePath, { key, servers });
	return servers;
}

function readSkillServersFromDisk(skill: SkillLike): SkillServers {
	const sidecarPath = join(skill.baseDir, "mcp.json");
	if (existsSync(sidecarPath)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(sidecarPath, "utf8"));
			return { declared: unwrapServerMap(parsed), sourcePath: sidecarPath };
		} catch (error) {
			return {
				declared: {},
				sourcePath: sidecarPath,
				warning: `Skill '${skill.name}': invalid mcp.json sidecar skipped (${error instanceof Error ? error.message : String(error)}); the skill itself still loads.`,
			};
		}
	}
	try {
		const { frontmatter } = parseFrontmatter<{ mcp?: unknown }>(readFileSync(skill.filePath, "utf8"));
		if (frontmatter.mcp === undefined) return { declared: {}, sourcePath: skill.filePath };
		return { declared: unwrapServerMap(frontmatter.mcp), sourcePath: skill.filePath };
	} catch (error) {
		return {
			declared: {},
			sourcePath: skill.filePath,
			warning: `Skill '${skill.name}': unreadable frontmatter mcp block skipped (${error instanceof Error ? error.message : String(error)}); the skill itself still loads.`,
		};
	}
}

function unwrapServerMap(value: unknown): Record<string, RawServer & { includeTools?: string[] }> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const record = value as Record<string, unknown>;
	const map = typeof record.mcpServers === "object" && record.mcpServers !== null ? record.mcpServers : record;
	const declared: Record<string, RawServer & { includeTools?: string[] }> = {};
	for (const [name, server] of Object.entries(map as Record<string, unknown>)) {
		if (typeof server !== "object" || server === null || Array.isArray(server)) continue;
		declared[name] = server as RawServer & { includeTools?: string[] };
	}
	return declared;
}

function normalizeGlobs(includeTools: unknown): string[] {
	if (!Array.isArray(includeTools)) return ["*"];
	const globs = includeTools.filter((glob): glob is string => typeof glob === "string" && glob.length > 0);
	return globs.length > 0 ? globs : ["*"];
}

/** `*`-only glob match against the ORIGINAL (server-side) tool name. */
export function matchIncludeTools(globs: readonly string[], toolName: string): boolean {
	return globs.some((glob) => {
		const pattern = `^${glob.split("*").map(escapeRegExp).join(".*")}$`;
		return new RegExp(pattern).test(toolName);
	});
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Names to reveal when `skillName` loads: for every server the skill declared,
 * every REGISTERED tool (mapped `mcp_<server>_<tool>` name) whose server-side
 * tool name matches the union of that skill's includeTools globs.
 */
export function skillActivationTargets(
	declarations: SkillMcpDeclarations,
	skillName: string,
	registered: ReadonlyArray<{ name: string; toolName: string; server: string }>,
): string[] {
	const targets = new Set<string>();
	for (const [serverName, decl] of declarations.servers) {
		const globs = decl.includeToolsBySkill.get(skillName);
		if (globs === undefined) continue;
		for (const tool of registered) {
			if (tool.server !== serverName) continue;
			if (matchIncludeTools(globs, tool.toolName)) targets.add(tool.name);
		}
	}
	return [...targets].sort();
}
