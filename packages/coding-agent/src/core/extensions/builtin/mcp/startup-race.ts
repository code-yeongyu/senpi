import type { ExtensionAPI } from "../../types.ts";
import { collectServerCatalogForCache, writeMcpCachedServer } from "./catalog-cache.ts";
import type { ResolvedMcpServer } from "./config-schema.ts";
import type { ServerConnection } from "./connection.ts";
import { markMcpConnectionNeedsAuth } from "./health.ts";
import { createMcpLogger } from "./log.ts";
import { ensureMcpResourceSubscriptions } from "./resources.ts";
import type { McpConnectionEntry } from "./service-types.ts";
import { safeTimer } from "./wrap.ts";

export const MCP_STARTUP_RACE_MS = 250;

export type McpStartupRaceResult = "settled" | "timeout";
export type McpToolRegistrar = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">;

interface RaceMcpStartupConnectOptions {
	readonly entry: McpConnectionEntry;
	readonly pi: McpToolRegistrar | undefined;
	readonly registerDirectTools: (pi: McpToolRegistrar) => Promise<void>;
	readonly serverConfig: ResolvedMcpServer["config"];
	readonly shouldRefreshTools: () => boolean;
}

export async function raceMcpStartupConnect(options: RaceMcpStartupConnectOptions): Promise<void> {
	const connect = ignoreStartupNeedsAuth(
		options.entry,
		connectAndRefreshMcpCatalog(options.entry, options.serverConfig),
	);
	const result = await waitForMcpStartupRace(connect);
	if (result === "settled" || options.pi === undefined) return;
	void connect.then(() => refreshMcpToolsAfterStartupRace(options));
}

export async function connectAndRefreshMcpCatalog(
	entry: McpConnectionEntry,
	serverConfig: ResolvedMcpServer["config"],
): Promise<void> {
	if (serverConfig === undefined) return;
	try {
		await entry.authPlan?.refresh?.ensureFresh();
	} catch (error) {
		const authError = markMcpConnectionNeedsAuth(entry.connection, error);
		if (authError !== undefined) {
			entry.logger.warn(authError.message);
			throw authError;
		}
		throw error;
	}
	await connectMcpServer(entry.connection, entry.logger);
	if (entry.connection.state !== "connected") return;
	if (entry.cacheRefreshedAfterConnect) return;
	entry.cacheRefreshedAfterConnect = true;
	try {
		const catalog = await collectServerCatalogForCache(entry.connection, serverConfig, entry.configHash);
		entry.cachedCatalog = catalog;
		await writeMcpCachedServer(entry.agentDir, entry.name, catalog);
		// Per-resource subscriptions (todo 39): only when the server declares
		// resources.subscribe; best-effort, failures are non-fatal.
		await ensureMcpResourceSubscriptions(entry.connection.client, catalog.resources ?? []);
	} catch (error) {
		entry.logger.warn("Failed to refresh MCP catalog cache", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

async function connectMcpServer(connection: ServerConnection, logger?: McpConnectionEntry["logger"]): Promise<void> {
	try {
		await connection.connect();
	} catch (error) {
		const failure = error instanceof Error ? error : new Error(String(error));
		if (connection.lastError === undefined) connection.markDegraded(failure);
		logger?.warn(failure.message);
	}
}

export async function ignoreStartupNeedsAuth(entry: McpConnectionEntry, connect: Promise<void>): Promise<void> {
	try {
		await connect;
	} catch (error) {
		if (entry.connection.state === "needs_auth") return;
		throw error;
	}
}

async function refreshMcpToolsAfterStartupRace(options: RaceMcpStartupConnectOptions): Promise<void> {
	if (options.pi === undefined || !options.shouldRefreshTools()) return;
	try {
		await options.registerDirectTools(options.pi);
	} catch (error) {
		createMcpLogger("service").warn("Failed to refresh MCP tools after startup race", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

export async function waitForMcpStartupRace(
	connect: Promise<void>,
	deadlineMs = MCP_STARTUP_RACE_MS,
): Promise<McpStartupRaceResult> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			connect.then(() => "settled" as const),
			new Promise<"timeout">((resolve) => {
				timeout = safeTimer("startup.race", deadlineMs, () => resolve("timeout"), {
					logger: createMcpLogger("startup"),
				});
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

export function shouldRaceMcpStartup(lifecycle: "lazy" | "eager" | "keep-alive"): boolean {
	return lifecycle === "eager" || lifecycle === "keep-alive";
}
