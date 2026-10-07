import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getAgentDir } from "../../../../config.ts";
import type { ExtensionAPI, ExtensionUIContext, SessionShutdownEvent, SessionStartEvent } from "../../types.ts";
import {
	getToolSearchService,
	getToolSearchServiceForExtension,
	resetToolSearchServiceForTests,
	ToolSearchService,
} from "../tool-search/service.ts";
import { mcpCredentialIdentity } from "./auth/catalog-identity.ts";
import { resolveAuthMode } from "./auth/context.ts";
import { cachedCatalogNeedsRefresh, getValidCachedServer, readMcpCatalogCache } from "./catalog-cache.ts";
import { loadMcpConfig, mergeExtensionMcpServers, visitSpawnableMcpServers } from "./config.ts";
import type { McpServerConfig, ResolvedMcpConfig, ResolvedMcpServer } from "./config-schema.ts";
import type { ServerConnection } from "./connection.ts";
import type { McpSessionRegistration } from "./expose/session.ts";
import type { McpServerExposureStatus } from "./expose/status.ts";
import { cleanupMcpOutputArtifacts, McpOutputArtifacts } from "./guard/output-guard.ts";
import { HostMcpRegistry } from "./host-registry.ts";
import { refreshMcpInstructionsForSession } from "./instructions.ts";
import { createMcpLogger } from "./log.ts";
import { reconnectMcpNow } from "./reconnect.ts";
import type { McpResourceServer } from "./resources.ts";
import { createMcpSessionConnection, disposeEntryConnection } from "./service-connection.ts";
import { getMcpServiceExposureStatus } from "./service-exposure.ts";
import { registerMcpServiceDirectTools } from "./service-register.ts";
import { buildMcpServerSnapshot } from "./service-snapshot.ts";
import { refreshMcpToolsOnListChanged, subscribeMcpToolsChanged } from "./service-tools-changed.ts";
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
import { resolveSkillMcpServer } from "./skill-server.ts";
import type { SkillServerRegistration } from "./skills.ts";
import {
	MCP_ATTACH_SETTLE_TIMEOUT_MS,
	McpDeferredAttach,
	type McpStartupRaceResult,
	raceMcpStartupConnect,
	shouldRaceMcpStartup,
} from "./startup-race.ts";
import { safeTimer } from "./wrap.ts";

type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
type ListedResource = Awaited<ReturnType<Client["listResources"]>>["resources"][number];
type ListedResourceTemplate = Awaited<ReturnType<Client["listResourceTemplates"]>>["resourceTemplates"][number];
type McpElicitationUi = Pick<ExtensionUIContext, "input" | "select" | "confirm">;
type McpToolRegistrar = Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">;

/**
 * One live session's binding to the service (#2514): the session's own extension API and
 * tool-search service, resolved per call, and what was registered there. Connections stay
 * shared across bindings; only the binding is per session.
 */
interface McpSessionBinding {
	readonly pi: McpToolRegistrar;
	/** Only for a session whose extension load owns no tool-search service (SDK and test hosts). */
	readonly fallbackToolSearch: ToolSearchService | undefined;
	/** True when `fallbackToolSearch` is the process-wide fallback rather than a private one. */
	readonly holdsProcessFallback: boolean;
	readonly context: McpSessionContext;
	readonly registeredIdentities: Map<string, string>;
	registration: McpSessionRegistration | undefined;
}

export { registerToolsPreservingActiveSet } from "./active-set.ts";

export class McpService {
	#disposed = false;
	#disposeCount = 0;
	#lastDisposeReason: McpDisposeReason | null = null;
	#sessionContext: McpSessionContext | null = null;
	#sessionStartCount = 0;
	#lastSessionStartReason: SessionStartEvent["reason"] | null = null;
	#config: ResolvedMcpConfig | null = null;
	#authAgentDir: string | undefined;
	#authEnv: Record<string, string | undefined> | undefined;
	#elicitationUiProvider: (() => McpElicitationUi | undefined) | undefined;
	#mcpInstructions = "";
	readonly #pendingAuth = new Map<string, import("./auth/oauth-provider.ts").McpOAuthProvider>();
	readonly #interactiveAuthServers = new Set<string>();
	readonly #promptCommandNames = new Set<string>();
	readonly #registrationListeners = new Set<() => void>();
	readonly #wireStatusListeners = new Set<(sessionId: string | undefined, snapshot: McpWireStatusSnapshot) => void>();
	#wireStatusRefreshQueue: Promise<void> = Promise.resolve();
	#refreshActiveSetWhenNoTools = false;
	readonly #bindings = new Map<object, McpSessionBinding>();
	#pendingAttaches = 0;
	// Sessions that quit while their own attach was still queued: the attach must not bind them (#2524 review).
	readonly #releasedSessions = new WeakSet<object>();
	#deferredDisposeReason: McpDisposeReason | undefined;
	// Releases waiting for the attaches that deferred their dispose: they settle once the last one does.
	readonly #deferredDisposeWaiters: Array<() => void> = [];
	#sessionOptions: McpSessionOptions = {};
	readonly #skillServerWarnings = new Set<string>();
	#attachQueue: Promise<void> = Promise.resolve();
	readonly #deferredAttach = new McpDeferredAttach();
	#latestWireStatus: McpWireStatusSnapshot = { servers: [] };
	readonly #wireStatusBySession = new Map<string, McpWireStatusSnapshot>();
	readonly #connections = new Map<string, McpConnectionEntry>();
	readonly #connectionKeysByName = new Map<string, string>();
	readonly #outputArtifacts = new McpOutputArtifacts();

	readonly #registry: HostMcpRegistry;
	readonly #shareConnections: boolean;
	readonly #servesManySessions: boolean;

	/** `servesManySessions` marks the process-wide service every classic session attaches to. */
	constructor(options: Pick<McpSessionOptions, "mcpRegistry"> & { readonly servesManySessions?: boolean } = {}) {
		this.#registry = options.mcpRegistry ?? new HostMcpRegistry();
		this.#shareConnections = options.mcpRegistry !== undefined;
		this.#servesManySessions = options.servesManySessions === true;
	}

	async attachSession(
		event: SessionStartEvent,
		ctx: McpSessionContext,
		_pi?: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools" | "registerTool">,
		options: McpSessionOptions = {},
	): Promise<void> {
		// Counted from the moment it queues, so a session's release cannot dispose the service
		// under an attach that has not bound yet.
		this.#pendingAttaches += 1;
		const attach = this.#attachQueue.then(async () => {
			if (this.#disposed) {
				throw new Error("The MCP service is disposed; attach the session to a live service instead.");
			}
			this.#sessionContext = ctx;
			this.#skillServerWarnings.clear();
			this.#sessionStartCount += 1;
			this.#lastSessionStartReason = event.reason;
			// Bind the agent dir at attach time: the startup race can background
			// the catalog cache write past this point, and it must land in the
			// directory this attach resolved, never wherever the environment
			// points when the write finally runs.
			const sessionOptions: McpSessionOptions =
				options.agentDir === undefined ? { ...options, agentDir: getAgentDir() } : options;
			const config = loadMcpConfig({
				agentDir: sessionOptions.agentDir,
				cwd: ctx.cwd,
				env: sessionOptions.env,
				projectTrusted: sessionOptions.projectTrusted ?? ctx.isProjectTrusted(),
			});
			mergeExtensionMcpServers(config, ctx.getRegisteredMcpServers?.() ?? []);
			// Equivalent peer attachment must not retire another session's configuration fence.
			this.#config = JSON.stringify(this.#config) === JSON.stringify(config) ? this.#config : config;
			const binding = _pi === undefined || this.#releasedSessions.has(_pi) ? undefined : this.#bind(_pi, ctx);
			this.#authAgentDir = sessionOptions.agentDir;
			this.#authEnv = sessionOptions.env;
			this.#sessionOptions = sessionOptions;
			await this.#syncFromConfig(config, sessionOptions, event.reason !== "reload", binding);
			if (binding !== undefined) await this.#registerDirectTools(binding);
			// Replay promotion markers from the (possibly resumed) session history
			// BEFORE the first turn: the request tool snapshot is taken before the
			// per-turn context event fires, so the context-event replay alone lands
			// one turn late. Doing it here puts restored tools on the very first
			// wire payload after a --continue/resume.
			if (binding !== undefined) this.#rehydrateFromSessionHistory(binding);
			if (shouldCaptureWireStatus(ctx)) await this.refreshWireStatusSnapshot(ctx.sessionManager?.getSessionId?.());
		});
		this.#attachQueue = attach.then(
			() => undefined,
			() => undefined,
		);
		try {
			await attach;
		} finally {
			this.#pendingAttaches -= 1;
			await this.#disposeIfDeferredAndIdle();
		}
	}

	/** A release that found attaches still pending leaves the dispose to the last of them, once no session is bound. */
	async #disposeIfDeferredAndIdle(): Promise<void> {
		const reason = this.#deferredDisposeReason;
		if (reason === undefined || this.#pendingAttaches > 0) return;
		this.#deferredDisposeReason = undefined;
		// A session that attached meanwhile keeps the service; otherwise the deferred dispose runs now.
		if (this.#liveBindings().length === 0) await this.dispose(reason);
		for (const settle of this.#deferredDisposeWaiters.splice(0)) settle();
	}

	#bind(pi: McpToolRegistrar, ctx: McpSessionContext): McpSessionBinding {
		const activationRuntime = {
			getActiveTools: () => pi.getActiveTools(),
			setActiveTools: (names: readonly string[]) => pi.setActiveTools([...names]),
		};
		const previous = this.#bindings.get(pi);
		// A session-owned service serves exactly one session: a new attach takes over its binding.
		if (!this.#servesManySessions) this.#bindings.clear();
		let fallbackToolSearch: ToolSearchService | undefined;
		let holdsProcessFallback = false;
		const sessionToolSearch = getToolSearchServiceForExtension(pi);
		if (sessionToolSearch !== undefined) {
			sessionToolSearch.bindActivationRuntime(activationRuntime);
		} else if (this.#liveBindings().some((other) => other.pi !== pi && other.holdsProcessFallback)) {
			// The process-wide fallback already serves another live session; rebinding it would move that
			// session's activation runtime and catalog hook here, so this session gets its own (#2514).
			fallbackToolSearch = new ToolSearchService({ getAllTools: () => [], ...activationRuntime });
		} else {
			holdsProcessFallback = true;
			try {
				fallbackToolSearch = getToolSearchService();
				fallbackToolSearch.bindActivationRuntime(activationRuntime);
			} catch {
				fallbackToolSearch = getToolSearchService({ getAllTools: () => [], ...activationRuntime });
			}
		}
		const binding: McpSessionBinding = {
			pi,
			fallbackToolSearch,
			holdsProcessFallback,
			context: ctx,
			registeredIdentities: previous?.registeredIdentities ?? new Map(),
			registration: previous?.registration,
		};
		// Re-inserting keeps the most recent attach last, which is what a caller naming no session gets.
		this.#bindings.delete(pi);
		this.#bindings.set(pi, binding);
		return binding;
	}

	#toolSearchFor(binding: McpSessionBinding): ToolSearchService | undefined {
		return getToolSearchServiceForExtension(binding.pi) ?? binding.fallbackToolSearch;
	}

	#liveBindings(): McpSessionBinding[] {
		for (const [pi, binding] of this.#bindings) {
			// A disposed session retires its own tool-search service; its binding goes with it.
			if (getToolSearchServiceForExtension(binding.pi)?.isDisposed === true) this.#bindings.delete(pi);
		}
		return [...this.#bindings.values()];
	}

	/** The binding of the session that owns `pi`; without one, the most recently attached live session. */
	#bindingFor(pi: object | undefined): McpSessionBinding | undefined {
		return pi === undefined ? this.#liveBindings().at(-1) : this.#bindings.get(pi);
	}

	/**
	 * Release the binding of the session that owns `pi` (#2514). The shared connections keep
	 * serving every other live session; once none is left, `disposeReason` disposes the service
	 * the way that last session's own exit would.
	 */
	async releaseSession(pi: object, disposeReason?: McpDisposeReason): Promise<void> {
		const released = this.#bindings.get(pi);
		this.#bindings.delete(pi);
		if (disposeReason !== undefined) this.#releasedSessions.add(pi);
		const live = this.#liveBindings();
		const latest = live.at(-1);
		if (latest !== undefined) {
			if (released !== undefined && this.#sessionContext === released.context) this.#sessionContext = latest.context;
			return;
		}
		// A session whose attach is still queued has not bound yet but will use this service.
		if (disposeReason === undefined) return;
		if (this.#pendingAttaches === 0) {
			await this.dispose(disposeReason);
			return;
		}
		// The release settles only once the pending attaches have, so a caller that awaits it
		// (session shutdown, builtin removal) sees the service disposed, not a dispose scheduled later.
		this.#deferredDisposeReason = disposeReason;
		const settled = new Promise<"settled">((settle) => this.#deferredDisposeWaiters.push(() => settle("settled")));
		const deadlineMs = resolveMcpDeferredDisposeTimeoutMs();
		let timer: NodeJS.Timeout | undefined;
		const outcome = await Promise.race([
			settled,
			new Promise<"timeout">((expire) => {
				timer = safeTimer("deferred-dispose", deadlineMs, () => expire("timeout"), {
					logger: createMcpLogger("service"),
				});
			}),
		]);
		clearTimeout(timer);
		if (outcome === "settled" || this.#deferredDisposeReason === undefined) return;
		// A hung attach must not hold a reload or a quit forever: dispose anyway once the
		// deadline passes, unless a session bound in the meantime, and say so.
		this.#deferredDisposeReason = undefined;
		createMcpLogger("service").warn("MCP attach still pending at the dispose deadline; disposing anyway", {
			timeoutMs: deadlineMs,
			reason: disposeReason,
		});
		if (this.#liveBindings().length === 0) await this.dispose(disposeReason);
		for (const settle of this.#deferredDisposeWaiters.splice(0)) settle();
	}

	/**
	 * Register skill-declared MCP servers (todo 37). Skill servers are forced
	 * into search mode with no directTools, so their catalogs register with
	 * ZERO active tools until activateSkillMcpTools reveals them. A name
	 * collision with a system-configured server keeps the system config and
	 * returns a warning (system wins). `${VAR}` expansion follows the declaring
	 * skill's trust (skill-server.ts); each trust warning is returned once per session.
	 */
	async attachSkillMcpServers(declared: ReadonlyMap<string, SkillServerRegistration>, pi?: object): Promise<string[]> {
		const config = this.#config;
		const binding = this.#bindingFor(pi);
		if (config === null || binding === undefined) return [];
		const warnings: string[] = [];
		const projectTrusted = this.#sessionOptions.projectTrusted ?? this.#sessionContext?.isProjectTrusted() ?? false;
		let added = 0;
		for (const [name, decl] of declared) {
			const existing = config.servers[name];
			if (existing !== undefined && existing.source !== "skill") {
				warnings.push(
					`MCP server '${name}' from skill ${decl.sourcePath} collides with the ${existing.source} config; system config wins.`,
				);
				continue;
			}
			const { server: resolved, warning } = resolveSkillMcpServer(name, decl.raw, decl.sourcePath, {
				env: this.#sessionOptions.env,
				skillName: decl.skillName,
				trusted: decl.scope === "project" || decl.scope === undefined ? projectTrusted : true,
			});
			if (warning !== undefined && !this.#skillServerWarnings.has(warning)) {
				this.#skillServerWarnings.add(warning);
				warnings.push(warning);
			}
			if (resolved === undefined) continue;
			if (existing !== undefined && existing.configHash === resolved.configHash) continue;
			config.servers[name] = resolved;
			added += 1;
		}
		if (added > 0) {
			await this.#syncFromConfig(config, this.#sessionOptions, false, binding);
			await this.#registerDirectTools(binding);
			if (this.#sessionContext !== null && shouldCaptureWireStatus(this.#sessionContext)) {
				await this.refreshWireStatusSnapshot(this.#sessionContext.sessionManager?.getSessionId?.());
			}
		}
		return warnings;
	}

	/** Registered searchable catalog (mapped name + server-side tool name),
	 * used by the skills loader to compute activation targets. */
	getTierBSearchable(pi?: object): ReadonlyArray<{ name: string; toolName: string; server: string }> {
		return this.#bindingFor(pi)?.registration?.searchable ?? [];
	}

	/** Connected servers that list prompts (todo 40), for slash registration. */
	getMcpPromptServers(pi?: object): readonly import("./prompts.ts").McpPromptServer[] {
		return this.#bindingFor(pi)?.registration?.promptServers ?? [];
	}

	/** Connected servers that list resources (todo 39), for mention expansion. */
	getMcpResourceServers(pi?: object): readonly McpResourceServer[] {
		return this.#bindingFor(pi)?.registration?.resourceServers ?? [];
	}

	/** Subscribe to completed catalog registrations. Consumers must inspect the
	 * resulting snapshot because tool, resource, and prompt catalogs can become
	 * available in different startup-race generations. */
	onMcpRegistrationChanged(listener: () => void): () => void {
		this.#registrationListeners.add(listener);
		return () => this.#registrationListeners.delete(listener);
	}

	/**
	 * Await the startup connects the race backgrounded, bounded by `timeoutMs`.
	 * `attachSession` resolves at the race deadline, so consumers that assemble
	 * session state from the catalog - the first turn's system prompt - call this
	 * to OBSERVE the attach. A `"timeout"` result means the turn goes out with
	 * what has landed so far and the rest arrives on a later turn.
	 */
	whenAttachSettled(timeoutMs = MCP_ATTACH_SETTLE_TIMEOUT_MS): Promise<McpStartupRaceResult> {
		return this.#deferredAttach.wait(timeoutMs);
	}

	/** Subscribe to live MCP inventory transitions for session-scoped hosts. */
	onWireStatusChanged(listener: (sessionId: string | undefined, snapshot: McpWireStatusSnapshot) => void): () => void {
		this.#wireStatusListeners.add(listener);
		return () => this.#wireStatusListeners.delete(listener);
	}

	/** Refresh and return the current session-owned MCP wire inventory. */
	async refreshWireStatusSnapshot(sessionId?: string): Promise<McpWireStatusSnapshot> {
		const refresh = this.#wireStatusRefreshQueue.then(() => this.#captureWireStatus(sessionId));
		this.#wireStatusRefreshQueue = refresh.then(
			() => undefined,
			() => undefined,
		);
		await refresh;
		return this.getWireStatusSnapshot(sessionId);
	}

	/** Reveal skill-owned tools (todo 37): activation is effective the next
	 * turn, exactly like an tool_search promotion. Unknown names are ignored. */
	activateSkillMcpTools(names: readonly string[], pi?: object): void {
		this.#bindingFor(pi)?.registration?.activate(names);
	}

	#rehydrateFromSessionHistory(binding: McpSessionBinding): void {
		const entries = binding.context.sessionManager?.getEntries() ?? [];
		if (entries.length === 0) return;
		this.#toolSearchFor(binding)?.maybeRehydrateFromHistory(entries);
	}

	async handleSessionShutdown(event: SessionShutdownEvent): Promise<void> {
		if (shouldDisposeMcpService(event.reason)) await this.dispose(event.reason);
	}

	async dispose(reason: McpDisposeReason): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#disposeCount += 1;
		this.#lastDisposeReason = reason;
		this.#bindings.clear();
		this.#sessionContext = null;
		this.#config = null;
		this.#elicitationUiProvider = undefined;
		this.#mcpInstructions = "";
		this.#pendingAuth.clear();
		this.#interactiveAuthServers.clear();
		this.#promptCommandNames.clear();
		this.#registrationListeners.clear();
		this.#wireStatusListeners.clear();
		this.#wireStatusBySession.clear();
		this.#latestWireStatus = { servers: [] };
		this.#deferredAttach.clear();
		const entries = [...this.#connections.values()];
		this.#connections.clear();
		this.#connectionKeysByName.clear();
		await Promise.all(entries.map((entry) => disposeEntryConnection(entry, this.#registry, this)));
		await cleanupMcpOutputArtifacts(this.#outputArtifacts);
	}

	getMcpOutputArtifacts(): McpOutputArtifacts {
		return this.#outputArtifacts;
	}

	isDisposed(): boolean {
		return this.#disposed;
	}

	getConnection(name: string): ServerConnection | undefined {
		const key = this.#connectionKeysByName.get(name);
		const entry = key === undefined ? undefined : this.#connections.get(key);
		return entry?.credentialsCurrent?.() === false ? undefined : entry?.connection;
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
		binding: McpSessionBinding | undefined,
	): Promise<void> {
		const cache = await readMcpCatalogCache(options.agentDir);
		const hadConnectionsBeforeSync = this.#connections.size > 0;
		this.#refreshActiveSetWhenNoTools = Object.keys(config.servers).length > 0 || hadConnectionsBeforeSync;
		const wanted = new Map<string, ResolvedMcpServer>();
		const credentialIdentities = new Map<string, string | undefined>();
		visitSpawnableMcpServers(config, (name, server) => {
			wanted.set(name, server);
			if (server.config !== undefined) {
				credentialIdentities.set(name, mcpCredentialIdentity(server.config, name, options.agentDir, options.env));
			}
		});
		const disposals: Promise<void>[] = [];
		for (const entry of this.#connections.values()) {
			const server = wanted.get(entry.name);
			const key =
				server?.configHash === undefined
					? undefined
					: `${entry.name}\0${server.configHash}\0${credentialIdentities.get(entry.name) ?? "unknown"}`;
			if (key === entry.key) continue;
			this.#connections.delete(entry.key);
			this.#connectionKeysByName.delete(entry.name);
			disposals.push(disposeEntryConnection(entry, this.#registry, this));
		}
		await Promise.all(disposals);

		const connects: Promise<void>[] = [];
		for (const [name, server] of wanted) {
			if (server.config === undefined || server.configHash === undefined) continue;
			const serverConfig = server.config;
			const credentialIdentity = credentialIdentities.get(name);
			const key = `${name}\0${server.configHash}\0${credentialIdentity ?? "unknown"}`;
			if (this.#connections.has(key)) continue;
			const entry = createMcpSessionConnection({
				registry: this.#registry,
				share: this.#shareConnections,
				owner: this,
				key,
				name,
				configHash: server.configHash,
				config: server.config,
				credentialIdentity,
				credentialsCurrent: () =>
					mcpCredentialIdentity(serverConfig, name, options.agentDir, options.env) === credentialIdentity,
				onCredentialsChanged: async () => {
					if (this.#disposed || this.#config !== config || this.#entryForName(name) !== entry) return;
					await this.#syncFromConfig(config, options, true, binding);
					for (const live of this.#liveBindings()) await this.#registerDirectTools(live);
				},
				session: options,
				cwd: this.#sessionContext?.cwd ?? process.cwd(),
				ui: () => this.getMcpElicitationUi(),
				artifacts: this.#outputArtifacts,
				shouldReconnect: (current) =>
					!this.#disposed &&
					this.#entryForName(name) === current &&
					this.#config?.servers[name]?.state === "enabled" &&
					this.#config.servers[name]?.configHash === current.configHash,
			});
			const cachedCatalog =
				useCache && credentialIdentity !== undefined
					? getValidCachedServer(cache, name, server.configHash, credentialIdentity)
					: undefined;
			entry.cachedCatalog = cachedCatalog;
			this.#connections.set(key, entry);
			this.#connectionKeysByName.set(name, key);
			this.#wireListChanged(entry);
			// Every startup connect is bounded by the startup race and continues in
			// the background past the deadline (eager/keep-alive always; a cold lazy
			// server that has no cached catalog also races so a slow/wedged server
			// never gates attachSession -> before_agent_start -> the first turn).
			// A fresh cached lazy server connects only on demand. An aged matching
			// catalog remains usable while its background refresh runs.
			if (
				shouldRaceMcpStartup(server.config.lifecycle) ||
				cachedCatalog === undefined ||
				cachedCatalogNeedsRefresh(cachedCatalog)
			) {
				connects.push(
					raceMcpStartupConnect({
						entry,
						pi: binding?.pi,
						registerDirectTools: async () => {
							// The catalog is shared, so it lands in every live session, not only the one that
							// started the connect (#2514). One session's failure must not starve the others:
							// each registers on its own, and the failures are reported together afterwards.
							const failures: unknown[] = [];
							for (const live of this.#liveBindings()) {
								try {
									await this.#registerDirectTools(live);
									// A raced attach ran its history replay before this catalog
									// existed; replay now so restored tools still land on the
									// first turn's payload (idempotent: already-active names skip).
									this.#rehydrateFromSessionHistory(live);
								} catch (error) {
									failures.push(error);
								}
							}
							// The session instructions block was likewise captured at attach
							// time, before this server connected; rebuild it so the first
							// turn carries this server's instructions after a raced connect.
							refreshMcpInstructionsForSession(this);
							if (failures.length > 0) {
								throw new AggregateError(
									failures,
									`MCP ${name} catalog failed to register in ${failures.length} session(s)`,
								);
							}
						},
						serverConfig: server.config,
						// A later attach does not supersede this catalog: it registers in every live session. Skip it only
						// once the service is gone or this connection was replaced (#2524 review).
						shouldRefreshTools: () => !this.#disposed && this.#entryForName(name) === entry,
						deadlineMs: 0,
						onDeferred: (settled) => this.#deferredAttach.track(settled),
					}),
				);
			}
		}
		await Promise.all(connects);
	}

	#wireListChanged(entry: McpConnectionEntry): void {
		const sink = { logger: { error: (message: string, data?: unknown) => entry.logger.error(message, data) } };
		entry.disposeListChanged = subscribeMcpToolsChanged(
			entry,
			(connectOnly) => this.#handleServerToolsChanged(entry, connectOnly),
			sink,
		);
		const unsubscribeState = entry.connection.onStateChange(() => {
			const ctx = this.#sessionContext;
			if (ctx?.mode !== "rpc") return;
			void this.refreshWireStatusSnapshot(ctx.sessionManager?.getSessionId?.()).catch((error: unknown) => {
				entry.logger.error("Failed to refresh MCP control inventory", error);
			});
		});
		entry.disposeWireStatus = unsubscribeState;
	}

	async #handleServerToolsChanged(entry: McpConnectionEntry, connectOnly: boolean): Promise<void> {
		const config = this.#config;
		if (config === null || this.#liveBindings().length === 0) return;
		// Resolved when the refresh registers, not when it starts: a session that attaches while the
		// refresh is still listing tools must receive the refreshed catalog too.
		const targets = () =>
			this.#liveBindings().map((binding) => ({
				pi: binding.pi,
				registeredIdentity: () => binding.registeredIdentities.get(entry.key),
				register: () => this.#registerDirectTools(binding),
			}));
		await refreshMcpToolsOnListChanged(entry, targets, config, connectOnly);
	}

	async #registerDirectTools(binding: McpSessionBinding): Promise<void> {
		const config = this.#config;
		if (config === null) return;
		const toolSearchService = this.#toolSearchFor(binding);
		if (toolSearchService === undefined) return;
		binding.registration = await registerMcpServiceDirectTools(
			binding.pi,
			config,
			this.#connections.values(),
			toolSearchService,
			{
				refreshActiveSetWhenEmpty: this.#refreshActiveSetWhenNoTools,
				onRegistered: (entry, identity) => binding.registeredIdentities.set(entry.key, identity),
				contextRequired: binding.context.mode !== undefined,
				sessionManager: binding.context.sessionManager,
				isCurrent: (entry) =>
					!this.#disposed &&
					this.#config === config &&
					this.#bindings.get(binding.pi) === binding &&
					this.#entryForName(entry.name) === entry,
				publishCurrent: async () => {
					if (this.#bindings.get(binding.pi) === binding) await this.#registerDirectTools(binding);
				},
			},
		);
		const ctx = binding.context;
		if (ctx.mode === "rpc") {
			await this.refreshWireStatusSnapshot(ctx.sessionManager?.getSessionId?.());
		}
		for (const listener of this.#registrationListeners) listener();
	}

	/** Route compatibility callers through the shared ownership-aware scanner. */
	rehydrateActiveToolsFromHistory(messages: readonly unknown[], pi?: object): string[] {
		return this.maybeRehydrateFromHistory(messages, pi);
	}

	/** Shared service memoization keeps this scan once-per-catalog-generation. */
	maybeRehydrateFromHistory(messages: readonly unknown[], pi?: object): string[] {
		const binding = this.#bindingFor(pi);
		return (
			(binding === undefined ? undefined : this.#toolSearchFor(binding)?.maybeRehydrateFromHistory(messages)) ?? []
		);
	}

	#serverSnapshot(name: string): McpServerSnapshot {
		const entry = this.#entryForName(name);
		const config = this.#config?.servers[name]?.config;
		const connection = this.getConnection(name);
		connection?.refreshCapturedDiagnostics();
		const snapshot = buildMcpServerSnapshot(name, this.#config?.servers[name], connection, entry);
		if (
			config !== undefined &&
			entry?.connection.state === "needs_auth" &&
			mcpCredentialIdentity(config, name, entry.agentDir, this.#authEnv) === undefined
		) {
			return { ...snapshot, lifecycleState: "needs_auth", lastError: entry.connection.lastError?.message ?? null };
		}
		return snapshot;
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
		const previous = this.getWireStatusSnapshot(sessionId);
		this.#latestWireStatus = snapshot;
		if (sessionId !== undefined) this.#wireStatusBySession.set(sessionId, snapshot);
		if (JSON.stringify(previous) === JSON.stringify(snapshot)) return;
		for (const listener of this.#wireStatusListeners) listener(sessionId, snapshot);
	}

	async #captureWireStatusServer(name: string, server: ResolvedMcpServer | undefined): Promise<McpWireStatusServer> {
		const entry = this.#entryForName(name);
		const connection = this.getConnection(name);
		const connected = connection?.state === "connected";
		const needsAuth = !connected && this.#serverSnapshot(name).lifecycleState === "needs_auth";
		const cached = entry?.credentialsCurrent?.() === false ? undefined : entry?.cachedCatalog;
		const tools = cached?.tools ?? [];
		const resources = cached?.resources ?? [];
		const resourceTemplates = cached?.resourceTemplates ?? [];
		let serverInfo: McpWireServerInfo | null = null;

		if (connected && connection !== undefined) {
			const client = connection.client;
			const version = client.getServerVersion();
			if (version !== undefined) serverInfo = mapWireServerInfo(version);
		}

		return {
			name,
			serverInfo,
			tools: tools.map(mapWireTool),
			resources: resources.map(mapWireResource),
			resourceTemplates: resourceTemplates.map(mapWireResourceTemplate),
			authStatus: wireAuthStatus(entry, server, this.#authEnv),
			...(connection?.state === undefined && server?.state === undefined
				? {}
				: {
						status: needsAuth
							? "needs_auth"
							: entry?.startupCatalogClaim?.ownsRegistration()
								? "connecting"
								: (connection?.state ?? server?.state),
					}),
		};
	}

	#entryForName(name: string): McpConnectionEntry | undefined {
		const key = this.#connectionKeysByName.get(name);
		return key === undefined ? undefined : this.#connections.get(key);
	}

	setMcpInstructions(instructions: string): void {
		this.#mcpInstructions = instructions;
	}

	getMcpInstructions(): string {
		if ([...this.#connections.values()].some((entry) => entry.credentialsCurrent?.() === false)) {
			refreshMcpInstructionsForSession(this);
		}
		return this.#mcpInstructions;
	}

	setMcpElicitationUiProvider(provider: (() => McpElicitationUi | undefined) | undefined): void {
		this.#elicitationUiProvider = provider;
	}

	getMcpElicitationUi(): McpElicitationUi | undefined {
		return this.#elicitationUiProvider?.();
	}

	isMcpPromptCommandRegistered(name: string): boolean {
		return this.#promptCommandNames.has(name);
	}

	markMcpPromptCommandRegistered(name: string): void {
		this.#promptCommandNames.add(name);
	}

	beginInteractiveAuth(serverName: string): boolean {
		if (this.#interactiveAuthServers.has(serverName)) return false;
		this.#interactiveAuthServers.add(serverName);
		return true;
	}

	endInteractiveAuth(serverName: string): void {
		this.#interactiveAuthServers.delete(serverName);
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

	/** Live auth status without fetching catalogs or exposing credentials. */
	getServerAuthStatus(name: string): McpWireAuthStatus {
		return wireAuthStatus(this.#entryForName(name), this.#config?.servers[name], this.#authEnv);
	}

	getCachedInstructions(name: string): string | undefined {
		const entry = this.#entryForName(name);
		return entry?.credentialsCurrent?.() === false ? undefined : entry?.cachedCatalog?.instructions;
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
	env: Record<string, string | undefined> | undefined,
): McpWireAuthStatus {
	const mode = entry?.authPlan?.mode ?? (server?.config === undefined ? "none" : resolveAuthMode(server.config));
	switch (mode) {
		case "none":
			return "unsupported";
		case "bearer":
			return entry?.connection.state === "needs_auth" ? "notLoggedIn" : "bearerToken";
		case "oauth":
			return server?.config === undefined ||
				mcpCredentialIdentity(server.config, server.name, entry?.agentDir, env) === undefined
				? "notLoggedIn"
				: "oAuth";
		default:
			return assertNever(mode);
	}
}

function shouldCaptureWireStatus(ctx: McpSessionContext): boolean {
	return ctx.mode === "app-server" || ctx.mode === "rpc";
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
		service = new McpService({ servesManySessions: true });
	}
	return service;
}

export function shouldDisposeMcpService(reason: SessionShutdownEvent["reason"]): reason is McpDisposeReason {
	return reason === "quit" || reason === "reload";
}

export function resetMcpServiceForTests(): void {
	service = null;
	resetToolSearchServiceForTests();
}

export const MCP_DEFERRED_DISPOSE_TIMEOUT_ENV = "SENPI_MCP_DEFERRED_DISPOSE_TIMEOUT_MS";
const MCP_DEFERRED_DISPOSE_TIMEOUT_MS = 15_000;

/** How long a release waits for pending attaches before it disposes anyway. */
function resolveMcpDeferredDisposeTimeoutMs(): number {
	const raw = process.env[MCP_DEFERRED_DISPOSE_TIMEOUT_ENV]?.trim();
	if (raw !== undefined && raw.length > 0) {
		const value = Number(raw);
		if (Number.isFinite(value) && value >= 0) return value;
	}
	return MCP_DEFERRED_DISPOSE_TIMEOUT_MS;
}
