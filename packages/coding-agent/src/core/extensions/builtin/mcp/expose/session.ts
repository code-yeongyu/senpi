import type { ExtensionAPI } from "../../../types.ts";
import { collectToolCatalog, type McpToolCatalogEntry } from "../catalog.ts";
import type { ResolvedMcpConfig } from "../config-schema.ts";
import type { ServerConnection } from "../connection.ts";
import { createMcpLogger, type McpLogger } from "../log.ts";
import { computeMcpExposurePolicy } from "./policy.ts";
import { registerMcpCatalogTools } from "./register.ts";

export interface McpDirectRegistrationEntry {
	readonly name: string;
	readonly connection: ServerConnection;
	readonly logger: McpLogger;
}

export async function registerDirectMcpTools(
	pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">,
	config: ResolvedMcpConfig,
	entries: Iterable<McpDirectRegistrationEntry>,
): Promise<void> {
	const registeredEntries: McpToolCatalogEntry[] = [];
	const activeEntries: McpToolCatalogEntry[] = [];
	for (const entry of entries) {
		const server = config.servers[entry.name];
		if (server?.config === undefined) continue;
		if (entry.connection.state !== "connected") continue;
		const catalog = await collectToolCatalog(entry.name, entry.connection, server.config);
		const policy = computeMcpExposurePolicy(catalog, server.config, config.settings);
		for (const warning of policy.warnings) entry.logger.warn(warning);
		registeredEntries.push(...policy.registeredEntries);
		activeEntries.push(...policy.activeEntries);
	}
	registerMcpCatalogTools(pi, registeredEntries, activeEntries, (message) => createMcpLogger("service").warn(message));
}
