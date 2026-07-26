import type { ExtensionAPI } from "../../../types.ts";
import { cachedToolsToCatalogEntries, collectToolCatalog, type McpToolCatalogEntry } from "../catalog.ts";
import type { McpCachedServerCatalog } from "../catalog-cache.ts";
import type { ResolvedMcpConfig } from "../config-schema.ts";
import type { ServerConnection } from "../connection.ts";
import type { McpOutputArtifacts } from "../guard/output-guard.ts";
import { createMcpLogger, type McpLogger } from "../log.ts";
import type { McpPromptServer } from "../prompts.ts";
import { createMcpResourceTools, type McpResourceServer } from "../resources.ts";
import { computeMcpExposurePolicy } from "./policy.ts";
import type { McpCatalogRegistrationOptions } from "./register.ts";
import { type McpTierBRegistration, registerMcpTierBTools } from "./tier-b.ts";

export type McpSessionRegistration = McpTierBRegistration & {
	resourceServers: McpResourceServer[];
	promptServers: McpPromptServer[];
};

export interface McpDirectRegistrationEntry {
	readonly name: string;
	readonly connection: ServerConnection;
	readonly logger: McpLogger;
	readonly agentDir?: string;
	readonly artifacts?: McpOutputArtifacts;
	readonly cachedCatalog?: McpCachedServerCatalog;
	readonly ensureFresh?: () => Promise<void>;
	readonly ensureCachedToolConnected?: () => Promise<void>;
}

export async function registerDirectMcpTools(
	pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">,
	config: ResolvedMcpConfig,
	entries: Iterable<McpDirectRegistrationEntry>,
	options: McpCatalogRegistrationOptions = {},
): Promise<McpSessionRegistration | undefined> {
	const registeredEntries: McpToolCatalogEntry[] = [];
	const activeEntries: McpToolCatalogEntry[] = [];
	let searchMode = false;
	const proxyGateways: { server: string; entries: McpToolCatalogEntry[] }[] = [];
	const resourceServers: McpResourceServer[] = [];
	const promptServers: McpPromptServer[] = [];
	for (const entry of entries) {
		const server = config.servers[entry.name];
		if (server?.config === undefined) continue;
		const catalog =
			entry.cachedCatalog === undefined
				? entry.connection.state === "connected"
					? await collectToolCatalog(entry.name, entry.connection, server.config, {
							agentDir: entry.agentDir,
							artifacts: entry.artifacts,
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
							artifacts: entry.artifacts,
							ensureFresh: entry.ensureFresh,
							outputGuard: config.settings.outputGuard,
						},
					);
		const cachedPrompts = entry.cachedCatalog?.prompts ?? [];
		if (cachedPrompts.length > 0) {
			promptServers.push({
				connection: entry.connection,
				prompts: cachedPrompts,
				requestTimeoutMs: server.config.requestTimeoutMs,
				server: entry.name,
			});
		}
		const cachedResources = entry.cachedCatalog?.resources ?? [];
		if (cachedResources.length > 0) {
			resourceServers.push({
				agentDir: entry.agentDir,
				artifacts: entry.artifacts,
				connection: entry.connection,
				outputGuard: config.settings.outputGuard,
				requestTimeoutMs: server.config.requestTimeoutMs,
				resources: cachedResources,
				server: entry.name,
			});
		}
		const policy = computeMcpExposurePolicy(catalog, server.config, config.settings);
		for (const warning of policy.warnings) entry.logger.warn(warning);
		if (policy.mode === "search") searchMode = true;
		if (policy.mode === "proxy") proxyGateways.push({ entries: [...policy.filteredEntries], server: entry.name });
		registeredEntries.push(...policy.registeredEntries);
		activeEntries.push(...policy.activeEntries);
	}
	// Skip touching the active set only when there is genuinely nothing to do.
	if (
		registeredEntries.length === 0 &&
		activeEntries.length === 0 &&
		!searchMode &&
		proxyGateways.length === 0 &&
		options.refreshActiveSetWhenEmpty !== true
	) {
		return undefined;
	}
	const utilityTools = resourceServers.length > 0 ? createMcpResourceTools(() => resourceServers) : [];
	const registration = registerMcpTierBTools(
		pi,
		{ activeEntries, proxyGateways, registeredEntries, searchMode, settings: config.settings, utilityTools },
		(message) => createMcpLogger("service").warn(message),
	);
	return { ...registration, promptServers, resourceServers };
}
