import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpOAuthProvider } from "./auth/oauth-provider.ts";
import { McpConnectionAttempt } from "./connection-attempt.ts";
import type {
	ServerConnectionListener,
	ServerConnectionOptions,
	ServerConnectionState,
	ServerConnectionStateChangedEvent,
	ServerConnectionToolsChangedEvent,
} from "./connection-types.ts";
import { diagnoseCapturedMcpConnectFailure, diagnoseMcpConnectFailure } from "./diagnose.ts";
import { ConnectError } from "./errors.ts";
import type { McpLogger } from "./log.ts";
import { subscribeMcpServerLogging } from "./logging.ts";
import { isMcpNeedsAuthError } from "./needs-auth.ts";
import { subscribeMcpListChanged } from "./notifications.ts";
import { subscribeMcpResourceUpdated } from "./resources.ts";
import { connectMcpTransport, createMcpTransport, type McpTransportConnection } from "./transport.ts";
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
	#state: ServerConnectionState;
	readonly #attempt: McpConnectionAttempt;
	#lastError: Error | undefined;
	readonly #stateListeners = new Set<ServerConnectionListener<ServerConnectionStateChangedEvent>>();
	readonly #toolsListeners = new Set<ServerConnectionListener<ServerConnectionToolsChangedEvent>>();

	constructor(options: ServerConnectionOptions) {
		this.serverName = options.serverName;
		this.#config = options.config;
		this.#logger = options.logger;
		this.#env = options.env;
		this.#authProvider = options.authProvider;
		this.#elicitationUiProvider = options.elicitationUiProvider;
		this.#state = options.config.enabled ? "idle" : "disabled";
		this.#attempt = new McpConnectionAttempt({
			serverName: this.serverName,
			state: () => this.#state,
			setState: (state) => this.#setState(state),
			client: () => this.client,
			create: () => this.#createTransportConnection(),
			open: (connection, generation) => this.#connectTransport(connection, generation),
		});
	}

	get state(): ServerConnectionState {
		return this.#state;
	}
	get lastError(): Error | undefined {
		return this.#lastError;
	}
	get generation(): number {
		return this.#attempt.generation;
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
		if (this.#attempt.connection === undefined) {
			throw new ConnectError(`MCP server ${this.serverName} is not connected`, {
				phase: "client",
				serverName: this.serverName,
			});
		}
		return this.#attempt.connection.client;
	}

	getRootPid(): number | null {
		return this.#attempt.connection?.getRootPid() ?? null;
	}
	connect(): Promise<Client> {
		return this.#attempt.connect();
	}

	renew(): Promise<Client> {
		return this.#attempt.renew();
	}

	bumpGeneration(): Promise<void> {
		this.#lastError = undefined;
		return this.#attempt.invalidate("idle");
	}

	disable(): Promise<void> {
		this.#lastError = undefined;
		return this.#attempt.invalidate("disabled");
	}

	async dispose(): Promise<void> {
		await this.#attempt.invalidate("disabled");
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
			generation: this.generation,
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

	#createTransportConnection(): McpTransportConnection {
		return createMcpTransport({
			authProvider: this.#authProvider,
			config: this.#config,
			env: this.#env,
			elicitationUiProvider: this.#elicitationUiProvider,
			logger: this.#logger,
			serverName: this.serverName,
		});
	}

	#trackTransport(connection: McpTransportConnection, generation: number): void {
		connection.transport.onclose = wrapAsync(
			"connection.transport.onclose",
			() => {
				if (this.#attempt.isShuttingDown(connection)) return;
				if (connection === this.#attempt.pendingConnection && this.#state === "connecting") {
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
				if (connection !== this.#attempt.connection && connection !== this.#attempt.pendingConnection) return;
				if (generation === this.generation && this.#state !== "disabled") {
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
			if (this.#attempt.pendingConnection === connection) this.#attempt.pendingConnection = undefined;
			await this.#attempt.shutdown(connection);
			if (generation !== this.generation || this.#state === "disabled") {
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
		if (generation !== this.generation || this.#state === "disabled") {
			await this.#attempt.shutdown(connection);
			throw this.#connectError(`MCP server ${this.serverName} connect was superseded`, "connect", true);
		}
		if (this.#attempt.pendingConnection === connection) this.#attempt.pendingConnection = undefined;
		this.#attempt.connection = connection;
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
		this.#setState("connected");
		this.markToolsChanged("connect");
		return connection.client;
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
			generation: this.generation,
			error,
		});
	}

	#emit<TEvent>(listeners: Set<ServerConnectionListener<TEvent>>, event: TEvent): void {
		for (const listener of listeners) {
			void wrapAsync("connection.event", listener, this.#sink)(event);
		}
	}

	#markFailure(state: ServerConnectionState, error: Error | undefined): void {
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
