import type { ExtensionAPI } from "../../types.ts";
import { collectServerCatalogForCache, writeMcpCachedServer } from "./catalog-cache.ts";
import type { ResolvedMcpServer } from "./config-schema.ts";
import type { ServerConnection } from "./connection.ts";
import { markMcpConnectionNeedsAuth } from "./health.ts";
import { createMcpLogger } from "./log.ts";
import { ensureMcpResourceSubscriptions } from "./resources.ts";
import type { McpConnectionEntry, McpStartupCatalogClaim } from "./service-types.ts";
import { SharedMcpLease } from "./shared-lease.ts";
import { safeTimer } from "./wrap.ts";

export const MCP_STARTUP_RACE_MS = 250;
export const MCP_STARTUP_TIMEOUT_ENV = "SENPI_MCP_STARTUP_TIMEOUT_MS";
/**
 * How long a consumer that must OBSERVE the attach waits for the connects this
 * race backgrounded. Each connect is itself bounded by the server's
 * `connectTimeoutMs` (15s default), so this is the earlier point at which the
 * user's turn stops waiting and the server's catalog lands on a later turn.
 */
export const MCP_ATTACH_SETTLE_TIMEOUT_MS = 5_000;

/**
 * Resolve the startup-race window (ms) a server's attach connect is bounded by.
 * Precedence: the `SENPI_MCP_STARTUP_TIMEOUT_MS` env override (a global escape
 * hatch) beats the per-server `startupTimeoutMs`, which beats the default. A
 * non-numeric or negative env value is ignored; `0` is honored and makes the
 * startup window non-blocking (connect is backgrounded immediately).
 */
export function resolveMcpStartupTimeoutMs(configured?: number): number {
	const raw = process.env[MCP_STARTUP_TIMEOUT_ENV]?.trim();
	if (raw !== undefined && raw.length > 0) {
		const value = Number(raw);
		if (Number.isFinite(value) && value >= 0) return value;
	}
	return configured ?? MCP_STARTUP_RACE_MS;
}

export type McpStartupRaceResult = "settled" | "timeout";
export type McpToolRegistrar = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">;

interface RaceMcpStartupConnectOptions {
	readonly entry: McpConnectionEntry;
	readonly pi: McpToolRegistrar | undefined;
	readonly registerDirectTools: (pi: McpToolRegistrar) => Promise<void>;
	readonly serverConfig: ResolvedMcpServer["config"];
	readonly shouldRefreshTools: () => boolean;
	// Bounded startup window (ms) before the connect is backgrounded; defaults to
	// MCP_STARTUP_RACE_MS when omitted.
	readonly deadlineMs?: number;
	// Called with the full connect continuation when the race backgrounds it, so
	// consumers that must observe the attach can await the exact completion.
	readonly onDeferred: (settled: Promise<void>) => void;
}

/**
 * Completion signal for the connects `raceMcpStartupConnect` backgrounds.
 * session_start deliberately returns before a slow connect finishes; anything
 * that assembles session state from the catalog - the first turn's system
 * prompt build - awaits this instead of assuming the attach already landed.
 */
export class McpDeferredAttach {
	readonly #pending = new Set<Promise<void>>();

	track(settled: Promise<void>): void {
		// A failed connect still SETTLES the attach, which is what the barrier
		// asks about; this is also the one place that failure is finally handled,
		// so it is logged here rather than surfacing as an unhandled rejection.
		const tracked = settled.then(
			() => undefined,
			(error: unknown) => {
				createMcpLogger("startup").warn("Deferred MCP attach failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			},
		);
		this.#pending.add(tracked);
		void tracked.then(() => this.#pending.delete(tracked));
	}

	async wait(timeoutMs: number): Promise<McpStartupRaceResult> {
		const pending = [...this.#pending];
		if (pending.length === 0) return "settled";
		return await waitForMcpStartupRace(
			Promise.all(pending).then(() => undefined),
			timeoutMs,
		);
	}

	clear(): void {
		this.#pending.clear();
	}
}

export async function raceMcpStartupConnect(options: RaceMcpStartupConnectOptions): Promise<void> {
	const { entry, pi } = options;
	const claim: McpStartupCatalogClaim = {
		cachedCatalog: entry.cachedCatalog,
		ownsRegistration: () => pi !== undefined && options.shouldRefreshTools(),
		settled: () => connect,
	};
	entry.startupCatalogClaim = claim;
	const releaseClaim = (): void => {
		if (entry.startupCatalogClaim === claim) entry.startupCatalogClaim = undefined;
	};
	const connect = ignoreStartupNeedsAuth(entry, connectAndRefreshMcpCatalog(entry, options.serverConfig)).finally(
		releaseClaim,
	);
	const result = await waitForMcpStartupRace(connect, options.deadlineMs);
	if (result === "settled" || options.pi === undefined) return;
	options.onDeferred(connect.then(() => refreshMcpToolsAfterStartupRace(options)));
}

const catalogRefreshes = new WeakMap<McpConnectionEntry, Promise<void>>();

export function connectAndRefreshMcpCatalog(
	entry: McpConnectionEntry,
	serverConfig: ResolvedMcpServer["config"],
): Promise<void> {
	const pending = catalogRefreshes.get(entry);
	if (pending !== undefined) return pending;
	const refresh = refreshConnectedMcpCatalog(entry, serverConfig);
	catalogRefreshes.set(entry, refresh);
	const finish = (): void => {
		if (catalogRefreshes.get(entry) === refresh) catalogRefreshes.delete(entry);
	};
	void refresh.then(finish, finish);
	return refresh;
}

async function refreshConnectedMcpCatalog(
	entry: McpConnectionEntry,
	serverConfig: ResolvedMcpServer["config"],
): Promise<void> {
	if (serverConfig === undefined || entry.isCurrent?.() === false) return;
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
	if (entry.connection.state !== "connected" || entry.isCurrent?.() === false) return;
	const generation = entry.connection.generation;
	const ownsCatalog = (): boolean =>
		entry.isCurrent?.() !== false &&
		entry.connection.state === "connected" &&
		entry.connection.generation === generation;
	if (entry.connection instanceof SharedMcpLease) {
		const catalog = await entry.connection.catalog();
		if (!ownsCatalog()) return;
		entry.cachedCatalog = catalog;
		entry.catalogGeneration = generation;
		entry.cacheRefreshedAfterConnect = true;
		return;
	}
	if (entry.cacheRefreshedAfterConnect && entry.catalogGeneration === generation) return;
	try {
		const catalog = await collectServerCatalogForCache(entry.connection, serverConfig, entry.configHash);
		if (!ownsCatalog()) return;
		entry.cachedCatalog = catalog;
		entry.catalogGeneration = generation;
		entry.cacheRefreshedAfterConnect = true;
		await writeMcpCachedServer(entry.agentDir, entry.name, catalog);
		// Per-resource subscriptions (todo 39): only when the server declares
		// resources.subscribe; best-effort, failures are non-fatal.
		if (ownsCatalog()) await ensureMcpResourceSubscriptions(entry.connection.client, catalog.resources ?? []);
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
