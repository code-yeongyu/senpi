import type { ExtensionAPI, SessionShutdownEvent, SessionStartEvent } from "../../types.ts";
import { cachedToolsToCatalogEntries } from "./catalog.ts";
import {
	collectServerCatalogForCache,
	getValidCachedServer,
	readMcpCatalogCache,
	writeMcpCachedServer,
} from "./catalog-cache.ts";
import { loadMcpConfig, visitSpawnableMcpServers } from "./config.ts";
import type { ResolvedMcpConfig, ResolvedMcpServer } from "./config-schema.ts";
import { ServerConnection } from "./connection.ts";
import { registerDirectMcpTools } from "./expose/session.ts";
import {
	getMcpCatalogExposureStatus,
	getMcpServerExposureStatus,
	type McpServerExposureStatus,
} from "./expose/status.ts";
import { createMcpLogger } from "./log.ts";
import { buildMcpServerSnapshot } from "./service-snapshot.ts";
import type {
	McpConnectionEntry,
	McpDisposeReason,
	McpServerSnapshot,
	McpServiceSnapshot,
	McpSessionContext,
	McpSessionOptions,
} from "./service-types.ts";

export { registerToolsPreservingActiveSet } from "./active-set.ts";

export class McpService {
	#disposed = false;
	#disposeCount = 0;
	#lastDisposeReason: McpDisposeReason | null = null;
	#sessionContext: McpSessionContext | null = null;
	#sessionStartCount = 0;
	#lastSessionStartReason: SessionStartEvent["reason"] | null = null;
	#config: ResolvedMcpConfig | null = null;
	readonly #connections = new Map<string, McpConnectionEntry>();
	readonly #connectionKeysByName = new Map<string, string>();

	async attachSession(
		event: SessionStartEvent,
		ctx: McpSessionContext,
		_pi?: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">,
		options: McpSessionOptions = {},
	): Promise<void> {
		this.#sessionContext = ctx;
		this.#sessionStartCount += 1;
		this.#lastSessionStartReason = event.reason;
		const config = loadMcpConfig({
			agentDir: options.agentDir,
			cwd: ctx.cwd,
			env: options.env,
			projectTrusted: options.projectTrusted ?? ctx.isProjectTrusted(),
		});
		this.#config = config;
		await this.#syncFromConfig(config, options, event.reason !== "reload");
		if (_pi !== undefined) await this.#registerDirectTools(_pi);
	}

	async handleSessionShutdown(event: SessionShutdownEvent): Promise<void> {
		if (shouldDisposeMcpService(event.reason)) await this.dispose(event.reason);
	}

	async dispose(reason: McpDisposeReason): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#disposeCount += 1;
		this.#lastDisposeReason = reason;
		this.#sessionContext = null;
		this.#config = null;
		const entries = [...this.#connections.values()];
		this.#connections.clear();
		this.#connectionKeysByName.clear();
		await Promise.all(entries.map((entry) => entry.connection.dispose()));
	}

	isDisposed(): boolean {
		return this.#disposed;
	}

	getConnection(name: string): ServerConnection | undefined {
		const key = this.#connectionKeysByName.get(name);
		return key === undefined ? undefined : this.#connections.get(key)?.connection;
	}

	getServerSnapshots(): McpServerSnapshot[] {
		const names = new Set<string>(Object.keys(this.#config?.servers ?? {}));
		for (const entry of this.#connections.values()) names.add(entry.name);
		return [...names].sort().map((name) => this.#serverSnapshot(name));
	}

	getLogLines(name: string, maxLines: number): string[] {
		const key = this.#connectionKeysByName.get(name);
		const lines = key === undefined ? [] : (this.#connections.get(key)?.logger.getRingBuffer() ?? []);
		return lines.slice(Math.max(0, lines.length - maxLines));
	}

	async getServerExposureStatus(name: string): Promise<McpServerExposureStatus> {
		const config = this.#config;
		if (config === null) return { toolCount: null };
		const server = config.servers[name];
		const entry = this.#entryForName(name);
		if (server?.config === undefined || entry === undefined) {
			return { toolCount: null };
		}
		const serverConfig = server.config;
		if (entry.cachedCatalog !== undefined && entry.connection.state !== "connected") {
			const catalog = cachedToolsToCatalogEntries(
				name,
				entry.cachedCatalog,
				entry.connection,
				serverConfig.requestTimeoutMs,
				() => this.#connectAndRefresh(entry, serverConfig),
			);
			return getMcpCatalogExposureStatus(catalog, serverConfig, config.settings);
		}
		if (entry.connection.state !== "connected") return { toolCount: null };
		return getMcpServerExposureStatus(name, entry.connection, serverConfig, config.settings);
	}

	recordCall(name: string, elapsedMs: number, failed: boolean): void {
		const key = this.#connectionKeysByName.get(name);
		const entry = key === undefined ? undefined : this.#connections.get(key);
		if (entry === undefined) return;
		entry.counters.callCount += 1;
		entry.counters.totalLatencyMs += elapsedMs;
		if (failed) entry.counters.errorCount += 1;
	}

	getSnapshot(): McpServiceSnapshot {
		return {
			disposed: this.#disposed,
			disposeCount: this.#disposeCount,
			lastDisposeReason: this.#lastDisposeReason,
			sessionStartCount: this.#sessionStartCount,
			lastSessionStartReason: this.#lastSessionStartReason,
			hasSessionContext: this.#sessionContext !== null,
			connectionCount: this.#connections.size,
		};
	}

	async #syncFromConfig(config: ResolvedMcpConfig, options: McpSessionOptions, useCache: boolean): Promise<void> {
		const cache = await readMcpCatalogCache(options.agentDir);
		const wanted = new Map<string, ResolvedMcpServer>();
		visitSpawnableMcpServers(config, (name, server) => {
			wanted.set(name, server);
		});
		const disposals: Promise<void>[] = [];
		for (const entry of this.#connections.values()) {
			const server = wanted.get(entry.name);
			const key = server?.configHash === undefined ? undefined : `${entry.name}\0${server.configHash}`;
			if (key === entry.key) continue;
			this.#connections.delete(entry.key);
			this.#connectionKeysByName.delete(entry.name);
			disposals.push(entry.connection.dispose());
		}
		await Promise.all(disposals);

		const connects: Promise<void>[] = [];
		for (const [name, server] of wanted) {
			if (server.config === undefined || server.configHash === undefined) continue;
			const key = `${name}\0${server.configHash}`;
			if (this.#connections.has(key)) continue;
			const logger = createMcpLogger(name, { logDir: options.logDir });
			const connection = new ServerConnection({
				config: server.config,
				env: options.env,
				logger,
				serverName: name,
			});
			const cachedCatalog = useCache ? getValidCachedServer(cache, name, server.configHash) : undefined;
			const entry: McpConnectionEntry = {
				agentDir: options.agentDir,
				cacheRefreshedAfterConnect: false,
				cachedCatalog,
				key,
				name,
				configHash: server.configHash,
				connection,
				logger,
				createdAtMs: Date.now(),
				counters: { callCount: 0, errorCount: 0, totalLatencyMs: 0, reconnectCount: 0 },
			};
			this.#connections.set(key, entry);
			this.#connectionKeysByName.set(name, key);
			if (cachedCatalog === undefined) connects.push(this.#connectAndRefresh(entry, server.config));
		}
		await Promise.all(connects);
	}

	async #connect(connection: ServerConnection): Promise<void> {
		try {
			await connection.connect();
		} catch (error) {
			if (connection.lastError === undefined) {
				connection.markDegraded(error instanceof Error ? error : new Error(String(error)));
			}
		}
	}

	async #connectAndRefresh(entry: McpConnectionEntry, serverConfig: ResolvedMcpServer["config"]): Promise<void> {
		if (serverConfig === undefined) return;
		await this.#connect(entry.connection);
		if (entry.connection.state !== "connected") return;
		if (entry.cacheRefreshedAfterConnect) return;
		entry.cacheRefreshedAfterConnect = true;
		try {
			const catalog = await collectServerCatalogForCache(entry.connection, serverConfig, entry.configHash);
			entry.cachedCatalog = catalog;
			await writeMcpCachedServer(entry.agentDir, entry.name, catalog);
		} catch (error) {
			entry.logger.warn("Failed to refresh MCP catalog cache", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #registerDirectTools(
		pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">,
	): Promise<void> {
		const config = this.#config;
		if (config === null) return;
		const entries = [...this.#connections.values()].map((entry) => {
			const serverConfig = config.servers[entry.name]?.config;
			return {
				cachedCatalog: entry.cachedCatalog,
				connection: entry.connection,
				ensureCachedToolConnected: () => this.#connectAndRefresh(entry, serverConfig),
				logger: entry.logger,
				name: entry.name,
			};
		});
		await registerDirectMcpTools(pi, config, entries);
	}

	#serverSnapshot(name: string): McpServerSnapshot {
		return buildMcpServerSnapshot(
			name,
			this.#config?.servers[name],
			this.getConnection(name),
			this.#entryForName(name),
		);
	}

	#entryForName(name: string): McpConnectionEntry | undefined {
		const key = this.#connectionKeysByName.get(name);
		return key === undefined ? undefined : this.#connections.get(key);
	}

	getCachedInstructions(name: string): string | undefined {
		return this.#entryForName(name)?.cachedCatalog?.instructions;
	}
}

let service: McpService | null = null;

export function getMcpService(): McpService {
	if (service === null || service.isDisposed()) {
		service = new McpService();
	}
	return service;
}

export function shouldDisposeMcpService(reason: SessionShutdownEvent["reason"]): reason is McpDisposeReason {
	return reason === "quit" || reason === "reload";
}

export function resetMcpServiceForTests(): void {
	service = null;
}
