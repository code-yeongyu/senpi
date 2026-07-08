import type { ExtensionAPI, SessionShutdownEvent, SessionStartEvent } from "../../types.ts";
import { detectLiteralBearerWarnings, resolveServerAuth } from "./auth/context.ts";
import { getValidCachedServer, readMcpCatalogCache } from "./catalog-cache.ts";
import { loadMcpConfig, visitSpawnableMcpServers } from "./config.ts";
import type { McpServerConfig, ResolvedMcpConfig, ResolvedMcpServer } from "./config-schema.ts";
import { ServerConnection } from "./connection.ts";
import type { McpServerExposureStatus } from "./expose/status.ts";
import { cleanupMcpOutputArtifacts } from "./guard/output-guard.ts";
import { markMcpConnectionNeedsAuth } from "./health.ts";
import { configureMcpConnectionLifecycle, disposeMcpConnectionLifecycle } from "./idle.ts";
import { createMcpLogger } from "./log.ts";
import { configureMcpReconnect, disposeMcpReconnect, reconnectMcpNow } from "./reconnect.ts";
import { getMcpServiceExposureStatus } from "./service-exposure.ts";
import { registerMcpServiceDirectTools } from "./service-register.ts";
import { buildMcpServerSnapshot } from "./service-snapshot.ts";
import type {
	McpConnectionEntry,
	McpDisposeReason,
	McpServerSnapshot,
	McpServiceSnapshot,
	McpSessionContext,
	McpSessionOptions,
} from "./service-types.ts";
import {
	connectAndRefreshMcpCatalog,
	ignoreStartupNeedsAuth,
	raceMcpStartupConnect,
	shouldRaceMcpStartup,
} from "./startup-race.ts";

export { registerToolsPreservingActiveSet } from "./active-set.ts";

export class McpService {
	#disposed = false;
	#disposeCount = 0;
	#lastDisposeReason: McpDisposeReason | null = null;
	#sessionContext: McpSessionContext | null = null;
	#sessionStartCount = 0;
	#lastSessionStartReason: SessionStartEvent["reason"] | null = null;
	#toolRefreshGeneration = 0;
	#config: ResolvedMcpConfig | null = null;
	#authAgentDir: string | undefined;
	#authEnv: Record<string, string | undefined> | undefined;
	readonly #pendingAuth = new Map<string, import("./auth/oauth-provider.ts").McpOAuthProvider>();
	#refreshActiveSetWhenNoTools = false;
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
		this.#authAgentDir = options.agentDir;
		this.#authEnv = options.env;
		const toolRefreshGeneration = this.#toolRefreshGeneration + 1;
		this.#toolRefreshGeneration = toolRefreshGeneration;
		await this.#syncFromConfig(config, options, event.reason !== "reload", _pi, toolRefreshGeneration);
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
		await Promise.all(entries.map((entry) => disposeEntryConnection(entry)));
		await cleanupMcpOutputArtifacts();
	}

	isDisposed(): boolean {
		return this.#disposed;
	}

	getConnection(name: string): ServerConnection | undefined {
		const key = this.#connectionKeysByName.get(name);
		return key === undefined ? undefined : this.#connections.get(key)?.connection;
	}

	async reconnectServer(name: string): Promise<void> {
		const entry = this.#entryForName(name);
		if (entry === undefined) throw new Error(`Unknown MCP server: ${name || "<missing>"}`);
		await reconnectMcpNow(entry.connection);
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
		return await getMcpServiceExposureStatus(name, this.#config, this.#entryForName(name));
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

	async #syncFromConfig(
		config: ResolvedMcpConfig,
		options: McpSessionOptions,
		useCache: boolean,
		pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool"> | undefined,
		toolRefreshGeneration: number,
	): Promise<void> {
		const cache = await readMcpCatalogCache(options.agentDir);
		const hadConnectionsBeforeSync = this.#connections.size > 0;
		this.#refreshActiveSetWhenNoTools = Object.keys(config.servers).length > 0 || hadConnectionsBeforeSync;
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
			disposals.push(disposeEntryConnection(entry));
		}
		await Promise.all(disposals);

		const connects: Promise<void>[] = [];
		for (const [name, server] of wanted) {
			if (server.config === undefined || server.configHash === undefined) continue;
			const key = `${name}\0${server.configHash}`;
			if (this.#connections.has(key)) continue;
			const logger = createMcpLogger(name, { logDir: options.logDir });
			const authPlan = resolveServerAuth({
				agentDir: options.agentDir,
				config: server.config,
				env: options.env,
				logger,
				serverName: name,
			});
			for (const warning of detectLiteralBearerWarnings(name, server.config)) logger.warn(warning);
			const connection = new ServerConnection({
				authProvider: authPlan.provider,
				config: server.config,
				env: options.env,
				logger,
				serverName: name,
			});
			const cachedCatalog = useCache ? getValidCachedServer(cache, name, server.configHash) : undefined;
			const entry: McpConnectionEntry = {
				agentDir: options.agentDir,
				authPlan,
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
			configureMcpConnectionLifecycle(connection, server.config, logger);
			configureMcpReconnect({
				connection,
				logger,
				reconnect: async () => {
					entry.counters.reconnectCount += 1;
					entry.cacheRefreshedAfterConnect = false;
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
					await entry.connection.renew();
					await connectAndRefreshMcpCatalog(entry, server.config);
				},
				shouldReconnect: () => !this.#disposed && this.#entryForName(name) === entry,
			});
			this.#connections.set(key, entry);
			this.#connectionKeysByName.set(name, key);
			if (shouldRaceMcpStartup(server.config.lifecycle)) {
				connects.push(
					raceMcpStartupConnect({
						entry,
						pi,
						registerDirectTools: (targetPi) => this.#registerDirectTools(targetPi),
						serverConfig: server.config,
						shouldRefreshTools: () => !this.#disposed && this.#toolRefreshGeneration === toolRefreshGeneration,
					}),
				);
			} else if (cachedCatalog === undefined) {
				connects.push(ignoreStartupNeedsAuth(entry, connectAndRefreshMcpCatalog(entry, server.config)));
			}
		}
		await Promise.all(connects);
	}

	async #registerDirectTools(
		pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">,
	): Promise<void> {
		const config = this.#config;
		if (config === null) return;
		await registerMcpServiceDirectTools(pi, config, this.#connections.values(), {
			refreshActiveSetWhenEmpty: this.#refreshActiveSetWhenNoTools,
		});
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

	getPendingAuth(): Map<string, import("./auth/oauth-provider.ts").McpOAuthProvider> {
		return this.#pendingAuth;
	}

	getAuthTarget(
		name: string,
	):
		| { config: McpServerConfig; agentDir?: string; env?: Record<string, string | undefined>; callbackUrl?: string }
		| undefined {
		const server = this.#config?.servers[name];
		if (server?.config === undefined) return undefined;
		return {
			config: server.config,
			agentDir: this.#authAgentDir,
			env: this.#authEnv,
			callbackUrl: this.#config?.settings.oauthCallbackUrl,
		};
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

async function disposeEntryConnection(entry: McpConnectionEntry): Promise<void> {
	disposeMcpReconnect(entry.connection);
	disposeMcpConnectionLifecycle(entry.connection);
	await entry.connection.dispose();
}

export function resetMcpServiceForTests(): void {
	service = null;
}
