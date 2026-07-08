import type { ExtensionAPI, SessionShutdownEvent, SessionStartEvent } from "../../types.ts";
import { detectLiteralBearerWarnings, resolveServerAuth } from "./auth/context.ts";
import { collectToolCatalog } from "./catalog.ts";
import { getValidCachedServer, readMcpCatalogCache } from "./catalog-cache.ts";
import { loadMcpConfig, resolveSkillMcpServer, visitSpawnableMcpServers } from "./config.ts";
import type { McpServerConfig, ResolvedMcpConfig, ResolvedMcpServer } from "./config-schema.ts";
import { ServerConnection } from "./connection.ts";
import { mapMcpCatalogNames } from "./expose/register.ts";
import type { McpSessionRegistration } from "./expose/session.ts";
import type { McpServerExposureStatus } from "./expose/status.ts";
import { cleanupMcpOutputArtifacts } from "./guard/output-guard.ts";
import { markMcpConnectionNeedsAuth } from "./health.ts";
import { configureMcpConnectionLifecycle, disposeMcpConnectionLifecycle } from "./idle.ts";
import { createMcpLogger } from "./log.ts";
import {
	buildMcpTombstoneDefinition,
	createMcpListChangeCoalescer,
	diffMcpToolNames,
	formatMcpListChangedDelta,
} from "./notifications.ts";
import { configureMcpReconnect, disposeMcpReconnect, reconnectMcpNow } from "./reconnect.ts";
import type { McpResourceServer } from "./resources.ts";
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
	#tierBRegistration: McpSessionRegistration | undefined;
	#historyScanned = false;
	#sessionOptions: McpSessionOptions = {};
	#pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool"> | undefined;
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
		this.#pi = _pi;
		this.#authAgentDir = options.agentDir;
		this.#authEnv = options.env;
		this.#sessionOptions = options;
		const toolRefreshGeneration = this.#toolRefreshGeneration + 1;
		this.#toolRefreshGeneration = toolRefreshGeneration;
		await this.#syncFromConfig(config, options, event.reason !== "reload", _pi, toolRefreshGeneration);
		if (_pi !== undefined) await this.#registerDirectTools(_pi);
		// Replay promotion markers from the (possibly resumed) session history
		// BEFORE the first turn: the request tool snapshot is taken before the
		// per-turn context event fires, so the context-event replay alone lands
		// one turn late. Doing it here puts restored tools on the very first
		// wire payload after a --continue/resume.
		if (_pi !== undefined) this.#rehydrateFromSessionHistory(ctx);
	}

	/**
	 * Register skill-declared MCP servers (todo 37). Skill servers are forced
	 * into search mode with no directTools, so their catalogs register with
	 * ZERO active tools until activateSkillMcpTools reveals them. A name
	 * collision with a system-configured server keeps the system config and
	 * returns a warning (system wins).
	 */
	async attachSkillMcpServers(
		declared: ReadonlyMap<string, { raw: Parameters<typeof resolveSkillMcpServer>[1]; sourcePath: string }>,
	): Promise<string[]> {
		const config = this.#config;
		const pi = this.#pi;
		if (config === null || pi === undefined) return [];
		const warnings: string[] = [];
		let added = 0;
		for (const [name, decl] of declared) {
			const existing = config.servers[name];
			if (existing !== undefined && existing.source !== "skill") {
				warnings.push(
					`MCP server '${name}' from skill ${decl.sourcePath} collides with the ${existing.source} config; system config wins.`,
				);
				continue;
			}
			const resolved = resolveSkillMcpServer(name, decl.raw, decl.sourcePath);
			if (existing !== undefined && existing.configHash === resolved.configHash) continue;
			config.servers[name] = resolved;
			added += 1;
		}
		if (added > 0) {
			const toolRefreshGeneration = this.#toolRefreshGeneration + 1;
			this.#toolRefreshGeneration = toolRefreshGeneration;
			await this.#syncFromConfig(config, this.#sessionOptions, false, pi, toolRefreshGeneration);
			await this.#registerDirectTools(pi);
		}
		return warnings;
	}

	/** Registered searchable catalog (mapped name + server-side tool name),
	 * used by the skills loader to compute activation targets. */
	getTierBSearchable(): ReadonlyArray<{ name: string; toolName: string; server: string }> {
		return this.#tierBRegistration?.searchable ?? [];
	}

	/** Connected servers that list resources (todo 39), for mention expansion. */
	getMcpResourceServers(): readonly McpResourceServer[] {
		return this.#tierBRegistration?.resourceServers ?? [];
	}

	/** Reveal skill-owned tools (todo 37): activation is effective the next
	 * turn, exactly like an mcp_search promotion. Unknown names are ignored. */
	activateSkillMcpTools(names: readonly string[]): void {
		this.#tierBRegistration?.activate(names);
	}

	#rehydrateFromSessionHistory(ctx: McpSessionContext): void {
		const entries = ctx.sessionManager?.getEntries() ?? [];
		if (entries.length === 0) return;
		this.rehydrateActiveToolsFromHistory(entries);
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
			this.#wireListChanged(entry);
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

	#wireListChanged(entry: McpConnectionEntry): void {
		const sink = { logger: { error: (message: string, data?: unknown) => entry.logger.error(message, data) } };
		const coalescer = createMcpListChangeCoalescer({
			onRefresh: () => this.#handleServerToolsChanged(entry),
			scope: `mcp.list_changed.${entry.name}`,
			sink,
		});
		const unsubscribe = entry.connection.onToolsChanged(() => coalescer.notify());
		entry.disposeListChanged = () => {
			unsubscribe();
			coalescer.dispose();
		};
	}

	// Re-list a server on a coalesced list_changed and re-register: added tools
	// enter INACTIVE (registerToolsPreservingActiveSet keeps the active set), and
	// removed tools are tombstoned so a stale call fails cleanly.
	async #handleServerToolsChanged(entry: McpConnectionEntry): Promise<void> {
		const pi = this.#pi;
		const config = this.#config;
		if (pi === undefined || config === null) return;
		const server = config.servers[entry.name];
		if (server?.config === undefined || entry.connection.state !== "connected") return;
		const catalog = await collectToolCatalog(entry.name, entry.connection, server.config, {
			agentDir: entry.agentDir,
			outputGuard: config.settings.outputGuard,
		});
		const newNames = mapMcpCatalogNames(catalog).map(({ name }) => name);
		const diff = diffMcpToolNames(entry.knownToolNames ?? newNames, newNames);
		// Tombstone removed tools BEFORE re-registration so the subsequent
		// setActiveTools (which excludes them) leaves the tombstones inactive.
		for (const removed of diff.removed) pi.registerTool(buildMcpTombstoneDefinition(removed, entry.name));
		await this.#registerDirectTools(pi);
		entry.knownToolNames = newNames;
		entry.lastListChangedDelta = formatMcpListChangedDelta(diff);
	}

	async #registerDirectTools(
		pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">,
	): Promise<void> {
		const config = this.#config;
		if (config === null) return;
		this.#tierBRegistration = await registerMcpServiceDirectTools(pi, config, this.#connections.values(), {
			refreshActiveSetWhenEmpty: this.#refreshActiveSetWhenNoTools,
		});
		// A (re-)registration recomputes the active set from config alone, so any
		// promotions recorded in history are worth replaying on the next scan.
		this.#historyScanned = false;
	}

	/**
	 * Replay mcp_search activation markers from session history through the
	 * live tier-B activation path (see tool-search.ts). Returns newly activated
	 * names; safe to call repeatedly (already-active names are skipped).
	 */
	rehydrateActiveToolsFromHistory(messages: readonly unknown[]): string[] {
		this.#historyScanned = true;
		return this.#tierBRegistration?.rehydrateFromHistory(messages) ?? [];
	}

	/**
	 * Once-per-registration variant for per-turn context events: scanning the
	 * full history each turn would cost O(history) JSON serialization, and a
	 * live session's active set only drifts from history when a (re-)registration
	 * rebuilt it — so scan once after each registration and skip otherwise.
	 */
	maybeRehydrateFromHistory(messages: readonly unknown[]): string[] {
		if (this.#historyScanned) return [];
		return this.rehydrateActiveToolsFromHistory(messages);
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

	/** Resolved `settings.nativeToolSearch` (auto | true | false | undefined).
	 * Drives the native provider tool-search adapter gate. */
	getNativeToolSearchSetting(): "auto" | boolean | undefined {
		return this.#config?.settings.nativeToolSearch;
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
	entry.disposeListChanged?.();
	disposeMcpReconnect(entry.connection);
	disposeMcpConnectionLifecycle(entry.connection);
	await entry.connection.dispose();
}

export function resetMcpServiceForTests(): void {
	service = null;
}
