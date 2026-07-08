import { cachedToolsToCatalogEntries } from "./catalog.ts";
import type { ResolvedMcpConfig } from "./config-schema.ts";
import {
	getMcpCatalogExposureStatus,
	getMcpServerExposureStatus,
	type McpServerExposureStatus,
} from "./expose/status.ts";
import type { McpConnectionEntry } from "./service-types.ts";
import { connectAndRefreshMcpCatalog } from "./startup-race.ts";

export async function getMcpServiceExposureStatus(
	name: string,
	config: ResolvedMcpConfig | null,
	entry: McpConnectionEntry | undefined,
): Promise<McpServerExposureStatus> {
	if (config === null) return { toolCount: null };
	const server = config.servers[name];
	if (server?.config === undefined || entry === undefined) return { toolCount: null };
	const serverConfig = server.config;
	if (entry.cachedCatalog !== undefined && entry.connection.state !== "connected") {
		const catalog = cachedToolsToCatalogEntries(
			name,
			entry.cachedCatalog,
			entry.connection,
			serverConfig.requestTimeoutMs,
			() => connectAndRefreshMcpCatalog(entry, serverConfig),
			{ ensureFresh: () => entry.authPlan?.refresh?.ensureFresh().then(() => undefined) ?? Promise.resolve() },
		);
		return getMcpCatalogExposureStatus(catalog, serverConfig, config.settings);
	}
	if (entry.connection.state !== "connected") return { toolCount: null };
	return await getMcpServerExposureStatus(name, entry.connection, serverConfig, config.settings);
}
