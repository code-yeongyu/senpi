import type { ExtensionAPI } from "../../../types.ts";
import { cachedToolsToCatalogEntries, collectToolCatalog, type McpToolCatalogEntry } from "../catalog.ts";
import type { McpCachedServerCatalog } from "../catalog-cache.ts";
import type { ResolvedMcpConfig } from "../config-schema.ts";
import type { ServerConnection } from "../connection.ts";
import { createMcpLogger, type McpLogger } from "../log.ts";
import { computeMcpExposurePolicy } from "./policy.ts";
import type { McpCatalogRegistrationOptions } from "./register.ts";
import { type McpTierBRegistration, registerMcpTierBTools } from "./tier-b.ts";

export interface McpDirectRegistrationEntry {
	readonly name: string;
	readonly connection: ServerConnection;
	readonly logger: McpLogger;
	readonly agentDir?: string;
	readonly cachedCatalog?: McpCachedServerCatalog;
	readonly ensureFresh?: () => Promise<void>;
	readonly ensureCachedToolConnected?: () => Promise<void>;
}

export async function registerDirectMcpTools(
	pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">,
	config: ResolvedMcpConfig,
	entries: Iterable<McpDirectRegistrationEntry>,
	options: McpCatalogRegistrationOptions = {},
): Promise<McpTierBRegistration | undefined> {
	const registeredEntries: McpToolCatalogEntry[] = [];
	const activeEntries: McpToolCatalogEntry[] = [];
	let searchMode = false;
	for (const entry of entries) {
		const server = config.servers[entry.name];
		if (server?.config === undefined) continue;
		const catalog =
			entry.cachedCatalog === undefined
				? entry.connection.state === "connected"
					? await collectToolCatalog(entry.name, entry.connection, server.config, {
							agentDir: entry.agentDir,
							ensureFresh: entry.ensureFresh,
							outputGuard: config.settings.outputGuard,
						})
					: []
				: cachedToolsToCatalogEntries(
						entry.name,
						entry.cachedCatalog,
						entry.connection,
						server.config.requestTimeoutMs,
						entry.ensureCachedToolConnected ?? (() => entry.connection.connect().then(() => undefined)),
						{
							agentDir: entry.agentDir,
							ensureFresh: entry.ensureFresh,
							outputGuard: config.settings.outputGuard,
						},
					);
		const policy = computeMcpExposurePolicy(catalog, server.config, config.settings);
		for (const warning of policy.warnings) entry.logger.warn(warning);
		if (policy.mode === "search") searchMode = true;
		registeredEntries.push(...policy.registeredEntries);
		activeEntries.push(...policy.activeEntries);
	}
	// Skip touching the active set only when there is genuinely nothing to do.
	if (
		registeredEntries.length === 0 &&
		activeEntries.length === 0 &&
		!searchMode &&
		options.refreshActiveSetWhenEmpty !== true
	) {
		return undefined;
	}
	return registerMcpTierBTools(
		pi,
		{ activeEntries, registeredEntries, searchMode, settings: config.settings },
		(message) => createMcpLogger("service").warn(message),
	);
}
