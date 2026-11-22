import { ConfigReferenceError } from "@earendil-works/pi-ai/utils/config-reference";
import type { RegisteredMcpServerDeclaration } from "../../types.ts";
import { hashConfig } from "./config-identity.ts";
import { normalizeServer } from "./config-normalize.ts";
import { refuseMcpReferences } from "./config-references.ts";
import type { RawConfig, ResolvedMcpConfig, ResolvedMcpServer } from "./config-schema.ts";

/**
 * Resolve an extension-declared MCP server. Preserves the declared exposure,
 * directTools, filters, lifecycle, and enabled state. A stdio declaration
 * without an explicit `cwd` defaults to the extension's registration cwd.
 */
export function resolveExtensionMcpServer(
	name: string,
	raw: NonNullable<RawConfig["mcpServers"]>[string],
	sourcePath: string,
	registrationCwd: string,
): ResolvedMcpServer {
	refuseMcpReferences(name, raw);
	const withCwd = { ...raw, cwd: raw.cwd ?? registrationCwd };
	const config = normalizeServer(withCwd);
	return {
		config,
		configHash: hashConfig(config),
		name,
		source: "extension",
		sourcePath,
		state: config.enabled ? "enabled" : "disabled",
		transport: config.type,
	};
}

/**
 * Merge extension-declared MCP servers into a resolved config. Trusted file
 * sources (global/claude/project) win, including disabled entries. An
 * extension entry replaces an untrusted placeholder and records a diagnostic.
 */
export function mergeExtensionMcpServers(
	result: ResolvedMcpConfig,
	declarations: readonly RegisteredMcpServerDeclaration[],
): void {
	for (const decl of declarations) {
		const existing = result.servers[decl.name];
		if (existing !== undefined && existing.state !== "untrusted") {
			result.diagnostics.push(
				`Extension MCP server '${decl.name}' from ${decl.extensionPath} skipped; ${existing.source} config at ${existing.sourcePath} wins.`,
			);
			continue;
		}
		if (existing !== undefined) {
			result.diagnostics.push(
				`Extension MCP server '${decl.name}' from ${decl.extensionPath} replaces untrusted ${existing.source} placeholder from ${existing.sourcePath}.`,
			);
		}
		try {
			result.servers[decl.name] = resolveExtensionMcpServer(
				decl.name,
				decl.config,
				decl.extensionPath,
				decl.registrationCwd,
			);
		} catch (error) {
			if (!(error instanceof ConfigReferenceError)) throw error;
			result.diagnostics.push(
				`Extension MCP server '${decl.name}' from ${decl.extensionPath} skipped: ${error.message}`,
			);
		}
	}
}
