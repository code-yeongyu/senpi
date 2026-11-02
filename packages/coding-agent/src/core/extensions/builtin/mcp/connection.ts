import { dirname } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { resolveServerAuth } from "./auth/context.ts";
import type { McpOAuthProvider } from "./auth/oauth-provider.ts";
import type {
	ServerConnectionListener,
	ServerConnectionOptions,
	ServerConnectionState,
	ServerConnectionStateChangedEvent,
	ServerConnectionToolsChangedEvent,
} from "./connection-types.ts";
import { diagnoseCapturedMcpConnectFailure, diagnoseMcpConnectFailure } from "./diagnose.ts";
import { ConnectError } from "./errors.ts";
import { legacyMcpFormEligible } from "./elicitation.ts";
import { isModernMcpClient, legacyMcpFormsAdvertised } from "./modern/request.ts";
import type { McpLogger } from "./log.ts";
import { subscribeMcpServerLogging } from "./logging.ts";
import { isMcpNeedsAuthError } from "./needs-auth.ts";
import { subscribeMcpListChanged } from "./notifications.ts";
import type { ProjectMcpMaterialization } from "./project-skill-policy.ts";
import { subscribeMcpResourceUpdated } from "./resources.ts";
import {
	connectMcpTransport,
	createMcpTransport,
	type McpTransportConnection,
	shutdownMcpTransport,
} from "./transport.ts";
import { type McpAsyncErrorSink, wrapAsync } from "./wrap.ts";

export type {
	ServerConnectionOptions,
	ServerConnectionState,
	ServerConnectionStateChangedEvent,
	ServerConnectionToolsChangedEvent,
} from "./connection-types.ts";

export class ServerConnection {
	readonly serverName: string;
	readonly #logger: McpLogger;
	readonly #env: Record<string, string | undefined> | undefined;
	readonly #config: ServerConnectionOptions["config"];
	readonly #authProvider: McpOAuthProvider | undefined;
	readonly #elicitationUiProvider: ServerConnectionOptions["elicitationUiProvider"];
	readonly #elicitationEnabled: ServerConnectionOptions["elicitationEnabled"];
	readonly #resolveConfig: ServerConnectionOptions["resolveConfig"];
	readonly #projectPolicy: ServerConnectionOptions["projectPolicy"];
	#policyAbort: AbortController | undefined;
	#requestLifetime = new AbortController();
	get requestLifetimeSignal(): AbortSignal {
		return this.#requestLifetime.signal;
	}
	#startedGrantNames: readonly string[] = [];
	#state: ServerConnectionState;
	#generation = 0;
	#connection: McpTransportConnection | undefined;
	#pendingConnection: McpTransportConnection | undefined;
	#pendingConnect: Promise<Client> | undefined;
	#renegotiatingForms: Promise<Client> | undefined;
	#stopFormReadiness: (() => void) | undefined;
	#lastError: Error | undefined;
	readonly #stateListeners = new Set<ServerConnectionListener<ServerConnectionStateChangedEvent>>();
	readonly #toolsListeners = new Set<ServerConnectionListener<ServerConnectionToolsChangedEvent>>();
	readonly #shutdownConnections = new Map<McpTransportConnection, Promise<void>>();

	constructor(options: ServerConnectionOptions) {
		this.serverName = options.serverName;
		this.#config = options.config;
		this.#logger = options.logger;
		this.#env = options.env;
		this.#authProvider = options.authProvider;
		this.#elicitationUiProvider = options.elicitationUiProvider;
		this.#elicitationEnabled = options.elicitationEnabled;
		this.#resolveConfig = options.resolveConfig;
		this.#projectPolicy = options.projectPolicy;
		this.#startedGrantNames = options.projectPolicy?.initial.grantedNames ?? [];
		this.#state = options.config.enabled ? "idle" : "disabled";
	}

	get state(): ServerConnectionState {
		return this.#state;
	}
	get declarationIdentity(): string | undefined {
		return this.#projectPolicy?.identity;
	}
	get projectPolicy(): ServerConnectionOptions["projectPolicy"] {
		return this.#projectPolicy;
	}
	get startedGrantNames(): readonly string[] {
		return this.#startedGrantNames;
	}
	get lastError(): Error | undefined {
		return this.#lastError;
	}
	get generation(): number {
		return this.#generation;
	}

	refreshCapturedDiagnostics(): void {
		const current = this.#lastError;
		if (current === undefined) return;
		const capturedError = diagnoseCapturedMcpConnectFailure({
			config: this.#config,
			cause: current,
			env: this.#env,
			logger: this.#logger,
			serverName: this.serverName,
		});
		if (capturedError !== null && capturedError.message !== current.message) {
			this.#lastError = capturedError;
		}
	}

	get client(): Client {
		if (this.#connection === undefined) {
			throw new ConnectError(`MCP server ${this.serverName} is not connected`, {
				phase: "client",
				serverName: this.serverName,
			});
		}
		return this.#connection.client;
	}

	getRootPid(): number | null {
		return this.#connection?.getRootPid() ?? null;
	}
	connect(): Promise<Client> {
		return this.#renegotiatingForms ?? this.#connect();
	}

	#legacyFormsChanged(client: Client): boolean {
		return (
			this.#elicitationUiProvider?.enforced?.() === true &&
			!isModernMcpClient(client) &&
			legacyMcpFormsAdvertised(client) !==
				legacyMcpFormEligible(this.#elicitationUiProvider, this.#elicitationEnabled !== false)
		);
	}

	#refreshLegacyForms(): void {
		if (this.#state !== "connected" || this.#renegotiatingForms || !this.#legacyFormsChanged(this.client)) return;
		// Publish the single flight before renewing: connect callers join it while the old transport closes.
		this.#renegotiatingForms = Promise.resolve()
			.then(() => this.renew())
			.finally(() => {
				this.#renegotiatingForms = undefined;
			});
		void this.#renegotiatingForms.catch((error: unknown) => {
			this.markDegraded(error instanceof Error ? error : new Error(String(error)));
		});
	}

	#connect(): Promise<Client> {
		if (this.#state === "disabled") {
			return Promise.reject(this.#connectError(`MCP server ${this.serverName} is disabled`, "connect"));
		}
		if (this.#elicitationUiProvider?.enforced?.())
			this.#stopFormReadiness ??= this.#elicitationUiProvider.subscribe?.(() => this.#refreshLegacyForms());
		if (this.#state === "connected") return Promise.resolve(this.client);
		if (this.#pendingConnect) return this.#pendingConnect;

		const generation = this.#generation;
		let attempt: Promise<Client>;
		if (this.#projectPolicy !== undefined) attempt = this.#openProjectConnection(generation);
		else {
			try {
				attempt = this.#openConnection(this.#createTransportConnection(), generation);
			} catch (error) {
				return Promise.reject(error);
			}
		}
		this.#pendingConnect = attempt.finally(() => {
			if (this.#pendingConnect !== undefined && generation === this.#generation) this.#pendingConnect = undefined;
		});
		// Emit "connecting" only after the single-flight promise is published, so a listener that calls
		// connect() joins this attempt instead of starting a second one.
		if (generation === this.#generation) this.#setState("connecting");
		return this.#pendingConnect;
	}
	async #openProjectConnection(generation: number): Promise<Client> {
		const policy = this.#projectPolicy;
		if (policy === undefined) throw this.#connectError("Missing project MCP policy", "create");
		const abort = new AbortController();
		this.#policyAbort = abort;
		try {
			const resolved = await policy.resolve(abort.signal);
			if (abort.signal.aborted || generation !== this.#generation) {
				throw this.#connectError("Project MCP materialization was invalidated; retry", "connect", true);
			}
			this.#startedGrantNames = resolved.grantedNames;
			return await this.#openConnection(this.#createTransportConnection(resolved), generation);
		} catch (error) {
			if (abort.signal.aborted || generation !== this.#generation) {
				throw this.#connectError("Project MCP materialization was invalidated; retry", "connect", true);
			}
			throw error;
		}
	}

	// Own the connection before discovery so a concurrent dispose can abort the probe.
	async #openConnection(connection: McpTransportConnection, generation: number): Promise<Client> {
		this.#pendingConnection = connection;
		try {
			return await this.#connectTransport(connection, generation);
		} finally {
			if (this.#pendingConnection === connection) this.#pendingConnection = undefined;
		}
	}

	async renew(): Promise<Client> {
		if (this.#state === "disabled") {
			throw this.#connectError(`MCP server ${this.serverName} is disabled`, "renew");
		}
		this.#policyAbort?.abort();
		this.#requestLifetime.abort();
		this.#requestLifetime = new AbortController();
		this.#generation++;
		this.#pendingConnect = undefined;
		this.#setState("idle");
		await this.#disposeOwnedConnections();
		return this.#connect();
	}

	bumpGeneration(): Promise<void> {
		this.#requestLifetime.abort();
		this.#requestLifetime = new AbortController();
		this.#policyAbort?.abort();
		this.#generation++;
		this.#pendingConnect = undefined;
		this.#lastError = undefined;
		if (this.#state !== "disabled") this.#setState("idle");
		return this.#disposeOwnedConnections();
	}

	disable(): Promise<void> {
		this.#stopFormReadiness?.();
		this.#stopFormReadiness = undefined;
		this.#requestLifetime.abort();
		this.#policyAbort?.abort();
		this.#generation++;
		this.#pendingConnect = undefined;
		this.#lastError = undefined;
		this.#setState("disabled");
		return this.#disposeOwnedConnections();
	}

	async dispose(): Promise<void> {
		this.#stopFormReadiness?.();
		this.#stopFormReadiness = undefined;
		this.#requestLifetime.abort();
		this.#policyAbort?.abort();
		this.#generation++;
		this.#pendingConnect = undefined;
		this.#setState("disabled");
		await this.#disposeOwnedConnections();
	}

	markDegraded(error: Error): void {
		this.#markFailure("degraded", error);
	}
	markSuspended(error?: Error): void {
		this.#markFailure("suspended", error);
	}
	markNeedsAuth(error?: Error): void {
		this.#markFailure("needs_auth", error);
	}
	markNeedsClientRegistration(error?: Error): void {
		this.#markFailure("needs_client_registration", error);
	}

	markToolsChanged(cause: ServerConnectionToolsChangedEvent["cause"] = "notification"): void {
		this.#emit(this.#toolsListeners, {
			type: "tools_changed",
			serverName: this.serverName,
			generation: this.#generation,
			cause,
		});
	}

	onStateChange(listener: ServerConnectionListener<ServerConnectionStateChangedEvent>): () => void {
		this.#stateListeners.add(listener);
		return () => this.#stateListeners.delete(listener);
	}

	onToolsChanged(listener: ServerConnectionListener<ServerConnectionToolsChangedEvent>): () => void {
		this.#toolsListeners.add(listener);
		return () => this.#toolsListeners.delete(listener);
	}

	#createTransportConnection(resolved?: ProjectMcpMaterialization): McpTransportConnection {
		const projectAbort = this.#policyAbort;
		const authProvider =
			resolved === undefined
				? this.#authProvider
				: resolveServerAuth({
						agentDir: this.#projectPolicy === undefined ? undefined : dirname(this.#projectPolicy.storePath),
						config: resolved.config,
						env: resolved.env,
						logger: this.#logger,
						serverName: this.serverName,
					}).provider;
		return createMcpTransport({
			authProvider,
			config: resolved?.config ?? this.#config,
			env: resolved?.env ?? this.#env,
			projectPolicy: resolved !== undefined,
			resolveProjectPolicy:
				resolved === undefined
					? undefined
					: async () => {
							const policy = this.#projectPolicy;
							const abort = projectAbort;
							if (policy === undefined || abort === undefined) {
								throw this.#connectError("Project MCP policy is no longer available", "create", true);
							}
							const current = await policy.resolve(abort.signal, false);
							abort.signal.throwIfAborted();
							this.#startedGrantNames = current.grantedNames;
							return current;
						},
			elicitationUiProvider: this.#elicitationUiProvider,
			elicitationEnabled: this.#elicitationEnabled,
			logger: this.#logger,
			resolveConfig: this.#resolveConfig,
			serverName: this.serverName,
		});
	}

	#trackTransport(connection: McpTransportConnection, generation: number): void {
		connection.transport.onclose = wrapAsync(
			"connection.transport.onclose",
			() => {
				if (this.#shutdownConnections.has(connection)) return;
				if (connection === this.#pendingConnection && this.#state === "connecting") {
					const closeError = this.#connectError(`MCP server ${this.serverName} transport closed`, "close", true);
					const capturedError = diagnoseCapturedMcpConnectFailure({
						config: this.#config,
						cause: closeError,
						env: this.#env,
						logger: this.#logger,
						serverName: this.serverName,
					});
					if (capturedError !== null) this.markDegraded(capturedError);
					return;
				}
				if (connection !== this.#connection && connection !== this.#pendingConnection) return;
				if (generation === this.#generation && this.#state !== "disabled") {
					this.markDegraded(this.#connectError(`MCP server ${this.serverName} transport closed`, "close", true));
				}
			},
			this.#sink,
		);
	}

	async #connectTransport(connection: McpTransportConnection, generation: number): Promise<Client> {
		try {
			await connection.materialize();
			this.#trackTransport(connection, generation);
			await connectMcpTransport(connection);
		} catch (error) {
			if (this.#pendingConnection === connection) this.#pendingConnection = undefined;
			await this.#shutdown(connection);
			if (generation !== this.#generation || this.#state === "disabled") {
				throw this.#connectError(`MCP server ${this.serverName} connect was superseded`, "connect", true);
			}
			if (error instanceof ConnectError && error.phase === "modern-stdio") {
				this.markDegraded(error);
				throw error;
			}
			if (isMcpNeedsAuthError(error)) {
				const authError = error instanceof Error ? error : new Error(String(error));
				this.markNeedsAuth(authError);
				throw authError;
			}
			const connectError = await diagnoseMcpConnectFailure({
				config: this.#config,
				cause: error instanceof Error ? error : new Error(String(error)),
				env: this.#env,
				logger: this.#logger,
				serverName: this.serverName,
			});
			this.markDegraded(connectError);
			throw connectError;
		}
		if (generation !== this.#generation || this.#state === "disabled") {
			await this.#shutdown(connection);
			throw this.#connectError(`MCP server ${this.serverName} connect was superseded`, "connect", true);
		}
		if (this.#pendingConnection === connection) this.#pendingConnection = undefined;
		this.#connection = connection;
		this.#lastError = undefined;
		// Subscribe to list_changed on the fresh client (even if the server never
		// declared the capability) so dynamic catalog updates reach the service.
		subscribeMcpListChanged(connection.client, () => this.markToolsChanged());
		// Resource updates ride the same refresh path: the service re-collects the
		// catalog (tools AND resources) on tools-changed.
		subscribeMcpResourceUpdated(connection.client, () => this.markToolsChanged());
		// Server logging notifications (todo 42): RFC-5424 → the per-server
		// logger, filtered by config.logLevel, burst-capped.
		subscribeMcpServerLogging(connection.client, { logLevel: this.#config.logLevel, logger: this.#logger });
		// Readiness can change while initialize is in flight; never publish that stale negotiation as connected.
		if (this.#legacyFormsChanged(connection.client)) return this.renew();
		this.#setState("connected");
		this.markToolsChanged("connect");
		return connection.client;
	}

	async #disposeOwnedConnections(): Promise<void> {
		const connections = new Set<McpTransportConnection>();
		const connection = this.#connection;
		this.#connection = undefined;
		if (connection !== undefined) connections.add(connection);
		const pendingConnection = this.#pendingConnection;
		this.#pendingConnection = undefined;
		if (pendingConnection !== undefined) connections.add(pendingConnection);
		await Promise.all([...connections].map((item) => this.#shutdown(item)));
	}

	async #shutdown(connection: McpTransportConnection): Promise<void> {
		const pending = this.#shutdownConnections.get(connection);
		if (pending !== undefined) {
			await pending;
			return;
		}
		const shutdown = (async () => {
			await shutdownMcpTransport(connection);
		})();
		this.#shutdownConnections.set(connection, shutdown);
		try {
			await shutdown;
		} finally {
			this.#shutdownConnections.delete(connection);
		}
	}

	#setState(state: ServerConnectionState, error?: Error): void {
		if (this.#state === state) return;
		const previousState = this.#state;
		this.#state = state;
		this.#emit(this.#stateListeners, {
			type: "state_changed",
			serverName: this.serverName,
			previousState,
			state,
			generation: this.#generation,
			error,
		});
	}

	#emit<TEvent>(listeners: Set<ServerConnectionListener<TEvent>>, event: TEvent): void {
		for (const listener of listeners) {
			void wrapAsync("connection.event", listener, this.#sink)(event);
		}
	}

	#markFailure(state: ServerConnectionState, error: Error | undefined): void {
		// disabled is terminal (dispose/disable): a late failure from an attempt it superseded must not revive it (senpi#4013).
		if (this.#state === "disabled") return;
		this.#lastError = error;
		this.#setState(state, error);
	}

	#connectError(message: string, phase: string, retriable?: true, cause?: unknown): ConnectError {
		return new ConnectError(message, { cause, phase, retriable, serverName: this.serverName });
	}

	get #sink(): McpAsyncErrorSink {
		return { logger: this.#logger };
	}
}
