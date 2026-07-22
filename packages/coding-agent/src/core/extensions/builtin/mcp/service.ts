import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ExtensionAPI, SessionShutdownEvent, SessionStartEvent } from "../../types.ts";
import { detectLiteralBearerWarnings, resolveAuthMode, resolveServerAuth } from "./auth/context.ts";
import { collectToolCatalog } from "./catalog.ts";
import { getValidCachedServer, readMcpCatalogCache } from "./catalog-cache.ts";
import { loadMcpConfig, mergeExtensionMcpServers, resolveSkillMcpServer, visitSpawnableMcpServers } from "./config.ts";
import type { McpServerConfig, ResolvedMcpConfig, ResolvedMcpServer } from "./config-schema.ts";
import { ServerConnection } from "./connection.ts";
import { collectAllPages } from "./expose/pagination.ts";
import { mapMcpCatalogNames } from "./expose/register.ts";
import type { McpSessionRegistration } from "./expose/session.ts";
import type { McpServerExposureStatus } from "./expose/status.ts";
import { cleanupMcpOutputArtifacts } from "./guard/output-guard.ts";
import { markMcpConnectionNeedsAuth } from "./health.ts";
import { configureMcpConnectionLifecycle, disposeMcpConnectionLifecycle } from "./idle.ts";
import { refreshMcpInstructionsForSession } from "./instructions.ts";
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
	McpWireAuthStatus,
	McpWireJsonValue,
	McpWireResource,
	McpWireResourceTemplate,
	McpWireServerInfo,
	McpWireStatusServer,
	McpWireStatusSnapshot,
	McpWireTool,
} from "./service-types.ts";
import {
	connectAndRefreshMcpCatalog,
	raceMcpStartupConnect,
	resolveMcpStartupTimeoutMs,
	shouldRaceMcpStartup,
} from "./startup-race.ts";

type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
type ListedResource = Awaited<ReturnType<Client["listResources"]>>["resources"][number];
type ListedResourceTemplate = Awaited<ReturnType<Client["listResourceTemplates"]>>["resourceTemplates"][number];

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
	#attachQueue: Promise<void> = Promise.resolve();
	#latestWireStatus: McpWireStatusSnapshot = { servers: [] };
	readonly #wireStatusBySession = new Map<string, McpWireStatusSnapshot>();
	readonly #connections = new Map<string, McpConnectionEntry>();
	readonly #connectionKeysByName = new Map<string, string>();

	async attachSession(
		event: SessionStartEvent,
		ctx: McpSessionContext,
		_pi?: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">,
		options: McpSessionOptions = {},
	): Promise<void> {
		const attach = this.#attachQueue.then(async () => {
			this.#sessionContext = ctx;
			this.#sessionStartCount += 1;
			this.#lastSessionStartReason = event.reason;
			const config = loadMcpConfig({
				agentDir: options.agentDir,
				cwd: ctx.cwd,
				env: options.env,
				projectTrusted: options.projectTrusted ?? ctx.isProjectTrusted(),
			});
			mergeExtensionMcpServers(config, ctx.getRegisteredMcpServers?.() ?? []);
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
			if (shouldCaptureWireStatus(ctx)) await this.#captureWireStatus(ctx.sessionManager?.getSessionId?.());
		});
		this.#attachQueue = attach.then(
			() => undefined,
			() => undefined,
		);
		await attach;
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
			if (this.#sessionContext !== null && shouldCaptureWireStatus(this.#sessionContext)) {
				await this.#captureWireStatus(this.#sessionContext.sessionManager?.getSessionId?.());
			}
		}
		return warnings;
	}

	/** Registered searchable catalog (mapped name + server-side tool name),
	 * used by the skills loader to compute activation targets. */
	getTierBSearchable(): ReadonlyArray<{ name: string; toolName: string; server: string }> {
		return this.#tierBRegistration?.searchable ?? [];
	}

	/** Connected servers that list prompts (todo 40), for slash registration. */
	getMcpPromptServers(): readonly import("./prompts.ts").McpPromptServer[] {
		return this.#tierBRegistration?.promptServers ?? [];
	}

	/** Connected servers that list resources (todo 39), for mention expansion. */
	getMcpResourceServers(): readonly McpResourceServer[] {
		return this.#tierBRegistration?.resourceServers ?? [];
	}

	/** Reveal skill-owned tools (todo 37): activation is effective the next
	 * turn, exactly like an tool_search promotion. Unknown names are ignored. */
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
		this.#wireStatusBySession.clear();
		this.#latestWireStatus = { servers: [] };
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

	/**
	 * Return the attach-time inventory captured for one session. This is the
	 * handoff consumed by the app-server's session-owned adapter; it deliberately
	 * does not expose or derive from the lifecycle-only server snapshots.
	 */
	getWireStatusSnapshot(sessionId?: string): McpWireStatusSnapshot {
		return sessionId === undefined
			? this.#latestWireStatus
			: (this.#wireStatusBySession.get(sessionId) ?? { servers: [] });
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
			// Every startup connect is bounded by the startup race and continues in
			// the background past the deadline (eager/keep-alive always; a cold lazy
			// server that has no cached catalog also races so a slow/wedged server
			// never gates attachSession -> before_agent_start -> the first turn).
			// A cached lazy server needs no startup connect: its tools come from the
			// cache and it connects on demand at tool-call time.
			if (shouldRaceMcpStartup(server.config.lifecycle) || cachedCatalog === undefined) {
				connects.push(
					raceMcpStartupConnect({
						entry,
						pi,
						registerDirectTools: async (targetPi) => {
							await this.#registerDirectTools(targetPi);
							// A raced attach ran its history replay before this catalog
							// existed; replay now so restored tools still land on the
							// first turn's payload (idempotent: already-active names skip).
							if (this.#sessionContext !== null) this.#rehydrateFromSessionHistory(this.#sessionContext);
							// The session instructions block was likewise captured at attach
							// time, before this server connected; rebuild it so the first
							// turn carries this server's instructions after a raced connect.
							refreshMcpInstructionsForSession(this);
						},
						serverConfig: server.config,
						shouldRefreshTools: () => !this.#disposed && this.#toolRefreshGeneration === toolRefreshGeneration,
						deadlineMs: resolveMcpStartupTimeoutMs(server.config.startupTimeoutMs),
					}),
				);
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
	 * Replay tool_search activation markers from session history through the
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
		const connection = this.getConnection(name);
		connection?.refreshCapturedDiagnostics();
		return buildMcpServerSnapshot(name, this.#config?.servers[name], connection, this.#entryForName(name));
	}

	async #captureWireStatus(sessionId: string | undefined): Promise<void> {
		const config = this.#config;
		if (config === null) return;
		const servers = await Promise.all(
			Object.keys(config.servers)
				.sort()
				.map((name) => this.#captureWireStatusServer(name, config.servers[name])),
		);
		const snapshot: McpWireStatusSnapshot = { servers };
		this.#latestWireStatus = snapshot;
		if (sessionId !== undefined) this.#wireStatusBySession.set(sessionId, snapshot);
	}

	async #captureWireStatusServer(name: string, server: ResolvedMcpServer | undefined): Promise<McpWireStatusServer> {
		const entry = this.#entryForName(name);
		const connection = entry?.connection;
		const connected = connection?.state === "connected";
		const cached = entry?.cachedCatalog;
		let tools = cached?.tools ?? [];
		let resources = cached?.resources ?? [];
		let resourceTemplates: ListedResourceTemplate[] = [];
		let serverInfo: McpWireServerInfo | null = null;

		if (connected && connection !== undefined) {
			const client = connection.client;
			const version = client.getServerVersion();
			if (version !== undefined) serverInfo = mapWireServerInfo(version);
			if (cached === undefined) {
				try {
					tools = (
						await collectAllPages<ListedTool>((cursor) =>
							client.listTools(cursor === undefined ? {} : { cursor }),
						)
					).items;
				} catch (error: unknown) {
					if (!(error instanceof Error)) throw error;
					tools = [];
				}
				try {
					resources = (
						await collectAllPages<ListedResource>((cursor) =>
							client.listResources(cursor === undefined ? {} : { cursor }),
						)
					).items;
				} catch (error: unknown) {
					if (!(error instanceof Error)) throw error;
					resources = [];
				}
			}
			try {
				resourceTemplates = (
					await collectAllPages<ListedResourceTemplate>((cursor) =>
						client.listResourceTemplates(cursor === undefined ? {} : { cursor }),
					)
				).items;
			} catch (error: unknown) {
				if (!(error instanceof Error)) throw error;
				resourceTemplates = [];
			}
		}

		return {
			name,
			serverInfo,
			tools: tools.map(mapWireTool),
			resources: resources.map(mapWireResource),
			resourceTemplates: resourceTemplates.map(mapWireResourceTemplate),
			authStatus: wireAuthStatus(entry, server),
		};
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

function wireAuthStatus(
	entry: McpConnectionEntry | undefined,
	server: ResolvedMcpServer | undefined,
): McpWireAuthStatus {
	const mode = entry?.authPlan?.mode ?? (server?.config === undefined ? "none" : resolveAuthMode(server.config));
	switch (mode) {
		case "none":
			return "unsupported";
		case "bearer":
			return entry?.connection.state === "needs_auth" ? "notLoggedIn" : "bearerToken";
		case "oauth":
			return entry?.authPlan?.provider?.tokens() === undefined ? "notLoggedIn" : "oAuth";
		default:
			return assertNever(mode);
	}
}

function shouldCaptureWireStatus(ctx: McpSessionContext): boolean {
	return ctx.mode === "app-server";
}

function mapWireServerInfo(info: NonNullable<ReturnType<Client["getServerVersion"]>>): McpWireServerInfo {
	return {
		name: info.name,
		title: info.title ?? null,
		version: info.version,
		description: info.description ?? null,
		icons: info.icons?.map(toWireJsonValue) ?? null,
		websiteUrl: info.websiteUrl ?? null,
	};
}

function mapWireTool(tool: ListedTool): McpWireTool {
	return {
		name: tool.name,
		...(tool.title === undefined ? {} : { title: tool.title }),
		...(tool.description === undefined ? {} : { description: tool.description }),
		inputSchema: toWireJsonValue(tool.inputSchema),
		...(tool.outputSchema === undefined ? {} : { outputSchema: toWireJsonValue(tool.outputSchema) }),
		...(tool.annotations === undefined ? {} : { annotations: toWireJsonValue(tool.annotations) }),
		...(tool.icons === undefined ? {} : { icons: tool.icons.map(toWireJsonValue) }),
		...(tool._meta === undefined ? {} : { _meta: toWireJsonValue(tool._meta) }),
	};
}

function mapWireResource(resource: ListedResource): McpWireResource {
	return {
		uri: resource.uri,
		name: resource.name,
		...(resource.title === undefined ? {} : { title: resource.title }),
		...(resource.description === undefined ? {} : { description: resource.description }),
		...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
		...(resource.size === undefined ? {} : { size: resource.size }),
		...(resource.annotations === undefined ? {} : { annotations: toWireJsonValue(resource.annotations) }),
		...(resource.icons === undefined ? {} : { icons: resource.icons.map(toWireJsonValue) }),
		...(resource._meta === undefined ? {} : { _meta: toWireJsonValue(resource._meta) }),
	};
}

function mapWireResourceTemplate(template: ListedResourceTemplate): McpWireResourceTemplate {
	return {
		uriTemplate: template.uriTemplate,
		name: template.name,
		...(template.title === undefined ? {} : { title: template.title }),
		...(template.description === undefined ? {} : { description: template.description }),
		...(template.mimeType === undefined ? {} : { mimeType: template.mimeType }),
		...(template.annotations === undefined ? {} : { annotations: toWireJsonValue(template.annotations) }),
		...(template.icons === undefined ? {} : { icons: template.icons.map(toWireJsonValue) }),
		...(template._meta === undefined ? {} : { _meta: toWireJsonValue(template._meta) }),
	};
}

function toWireJsonValue(value: unknown): McpWireJsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
		return value;
	}
	if (Array.isArray(value)) return value.map(toWireJsonValue);
	if (isRecord(value)) {
		const object: Record<string, McpWireJsonValue | undefined> = {};
		for (const [key, child] of Object.entries(value)) object[key] = toWireJsonValue(child);
		return object;
	}
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
	throw new Error(`Unhandled MCP auth mode: ${JSON.stringify(value)}`);
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
