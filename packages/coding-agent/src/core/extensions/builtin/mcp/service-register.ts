import type { ExtensionAPI, ExtensionUIContext } from "../../types.ts";
import type { ToolSearchService } from "../tool-search/service.ts";
import { cachedToolsToCatalogEntries } from "./catalog.ts";
import type { ResolvedMcpConfig } from "./config-schema.ts";
import { computeMcpExposurePolicy } from "./expose/policy.ts";
import type { McpSessionRegistration } from "./expose/session.ts";
import { registerDirectMcpTools } from "./expose/session.ts";
import { ensureMcpToolCallConnection } from "./health.ts";
import { createMcpInvocationResolver } from "./invocation.ts";
import type { McpConnectionEntry } from "./service-types.ts";
import type { McpRequestOrigin } from "./request-origin.ts";
import { connectAndRefreshMcpCatalog, prepareMcpAuthentication } from "./startup-race.ts";

type McpToolRegistrar = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">;

export interface McpServiceDirectToolRegistrationOptions {
	readonly requestOrigin?: (
		entry: McpConnectionEntry,
		caller?: { readonly sessionManager?: object },
	) => McpRequestOrigin;
	readonly bindPresentation?: (ui: ExtensionUIContext) => void;
	readonly refreshActiveSetWhenEmpty?: boolean;
	readonly onRegistered?: (entry: McpConnectionEntry, identity: string) => void;
	readonly isCurrent?: (entry: McpConnectionEntry) => boolean;
	readonly contextRequired?: boolean;
	readonly sessionManager?: object;
	readonly servesSession?: (sessionManager: object | undefined) => boolean;
	readonly publishCurrent?: () => Promise<void>;
}

export async function registerMcpServiceDirectTools(
	pi: McpToolRegistrar,
	config: ResolvedMcpConfig,
	entries: Iterable<McpConnectionEntry>,
	toolSearchService: ToolSearchService,
	options: McpServiceDirectToolRegistrationOptions = {},
): Promise<McpSessionRegistration | undefined> {
	return await registerDirectMcpTools(
		pi,
		config,
		[...entries].map((entry) => {
			const serverConfig = config.servers[entry.name]?.config;
			const claim = entry.startupCatalogClaim;
			const startupCatalogPending = claim?.ownsRegistration() === true;
			const invocation = createMcpInvocationResolver({
				owner: entry,
				sink: { logger: entry.logger },
				configuration: entry.configHash,
				contextRequired: options.contextRequired === true,
				sessionManager: options.sessionManager,
				servesSession: options.servesSession,
				isCurrent: () => entry.isCurrent?.() !== false && options.isCurrent?.(entry) !== false,
				ready: async () => {
					if (!(await prepareMcpAuthentication(entry))) return;
					if (entry.isCurrent?.() === false || options.isCurrent?.(entry) === false) return;
					if (entry.credentialsCurrent?.() === false) {
						await entry.onCredentialsChanged?.();
						return;
					}
					await ensureMcpToolCallConnection(entry.connection);
					if (entry.isCurrent?.() === false || options.isCurrent?.(entry) === false) return;
					if (entry.credentialsCurrent?.() === false) {
						await entry.onCredentialsChanged?.();
						return;
					}
					await connectAndRefreshMcpCatalog(entry, serverConfig);
					await entry.startupCatalogClaim?.settled();
					if (entry.isCurrent?.() === false || options.isCurrent?.(entry) === false) return;
					await options.publishCurrent?.();
				},
				current: (tool) => {
					if (
						serverConfig === undefined ||
						entry.credentialsCurrent?.() === false ||
						entry.cachedCatalog === undefined ||
						!entry.cacheRefreshedAfterConnect ||
						entry.catalogGeneration !== entry.connection.generation ||
						entry.connection.state !== "connected"
					) {
						return undefined;
					}
					const current = cachedToolsToCatalogEntries(
						entry.name,
						entry.cachedCatalog,
						entry.connection,
						serverConfig.requestTimeoutMs,
						() => connectAndRefreshMcpCatalog(entry, serverConfig),
						{
							agentDir: entry.agentDir,
							artifacts: entry.artifacts,
							ensureFresh: () =>
								entry.authPlan?.refresh?.ensureFresh().then(() => undefined) ?? Promise.resolve(),
							outputGuard: config.settings.outputGuard,
							invocation,
							requestOrigin: (caller) => options.requestOrigin?.(entry, caller),
						},
					);
					return computeMcpExposurePolicy(current, serverConfig, config.settings).filteredEntries.find(
						(candidate) => candidate.tool === tool,
					);
				},
			});
			return {
				agentDir: entry.agentDir,
				artifacts: entry.artifacts,
				cachedCatalog:
					entry.credentialsCurrent?.() === false
						? undefined
						: startupCatalogPending
							? claim?.cachedCatalog
							: entry.cachedCatalog,
				startupCatalogPending,
				localCatalogOnly: true,
				invocation,
				requestOrigin: (caller) => options.requestOrigin?.(entry, caller),
				bindPresentation: options.bindPresentation,
				onRegistered: (identity) => options.onRegistered?.(entry, identity),
				connection: entry.connection,
				ensureFresh: () => entry.authPlan?.refresh?.ensureFresh().then(() => undefined) ?? Promise.resolve(),
				ensureCachedToolConnected: () => connectAndRefreshMcpCatalog(entry, serverConfig),
				logger: entry.logger,
				name: entry.name,
			};
		}),
		toolSearchService,
		{ refreshActiveSetWhenEmpty: options.refreshActiveSetWhenEmpty },
	);
}
