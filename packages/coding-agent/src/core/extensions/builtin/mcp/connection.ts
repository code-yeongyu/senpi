import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServerConfig } from "./config-schema.ts";
import { ConnectError } from "./errors.ts";
import type { McpLogger } from "./log.ts";
import {
	connectMcpTransport,
	createMcpTransport,
	type McpTransportConnection,
	shutdownMcpTransport,
} from "./transport.ts";
import { type McpAsyncErrorSink, wrapAsync } from "./wrap.ts";

export type ServerConnectionState =
	| "disabled"
	| "idle"
	| "connecting"
	| "connected"
	| "degraded"
	| "suspended"
	| "needs_auth"
	| "needs_client_registration";

export type ServerConnectionStateChangedEvent = {
	readonly type: "state_changed";
	readonly serverName: string;
	readonly generation: number;
	readonly state: ServerConnectionState;
	readonly previousState: ServerConnectionState;
	readonly error?: Error;
};

export type ServerConnectionToolsChangedEvent = {
	readonly type: "tools_changed";
	readonly serverName: string;
	readonly generation: number;
};

export interface ServerConnectionOptions {
	readonly serverName: string;
	readonly config: McpServerConfig;
	readonly logger: McpLogger;
	readonly env?: Record<string, string | undefined>;
}

type Listener<TEvent> = (event: TEvent) => void | Promise<void>;

export class ServerConnection {
	readonly serverName: string;
	readonly #logger: McpLogger;
	readonly #env: Record<string, string | undefined> | undefined;
	readonly #config: McpServerConfig;
	#state: ServerConnectionState;
	#generation = 0;
	#connection: McpTransportConnection | undefined;
	#pendingConnection: McpTransportConnection | undefined;
	#pendingConnect: Promise<Client> | undefined;
	#lastError: Error | undefined;
	readonly #stateListeners = new Set<Listener<ServerConnectionStateChangedEvent>>();
	readonly #toolsListeners = new Set<Listener<ServerConnectionToolsChangedEvent>>();
	readonly #shutdownConnections = new Map<McpTransportConnection, Promise<void>>();

	constructor(options: ServerConnectionOptions) {
		this.serverName = options.serverName;
		this.#config = options.config;
		this.#logger = options.logger;
		this.#env = options.env;
		this.#state = options.config.enabled ? "idle" : "disabled";
	}

	get state(): ServerConnectionState {
		return this.#state;
	}
	get lastError(): Error | undefined {
		return this.#lastError;
	}
	get generation(): number {
		return this.#generation;
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
		if (this.#state === "disabled") {
			return Promise.reject(this.#connectError(`MCP server ${this.serverName} is disabled`, "connect"));
		}
		if (this.#state === "connected") return Promise.resolve(this.client);
		if (this.#pendingConnect) return this.#pendingConnect;

		const generation = this.#generation;
		const connection = this.#createTransportConnection(generation);
		this.#pendingConnection = connection;
		this.#setState("connecting");
		this.#pendingConnect = this.#connectTransport(connection, generation).finally(() => {
			if (this.#pendingConnect !== undefined && generation === this.#generation) this.#pendingConnect = undefined;
			if (this.#pendingConnection === connection) this.#pendingConnection = undefined;
		});
		return this.#pendingConnect;
	}

	async renew(): Promise<Client> {
		if (this.#state === "disabled") {
			throw this.#connectError(`MCP server ${this.serverName} is disabled`, "renew");
		}
		this.#generation++;
		this.#pendingConnect = undefined;
		this.#lastError = undefined;
		this.#setState("idle");
		await this.#disposeOwnedConnections();
		return this.connect();
	}

	bumpGeneration(): Promise<void> {
		this.#generation++;
		this.#pendingConnect = undefined;
		this.#lastError = undefined;
		if (this.#state !== "disabled") this.#setState("idle");
		return this.#disposeOwnedConnections();
	}

	disable(): Promise<void> {
		this.#generation++;
		this.#pendingConnect = undefined;
		this.#lastError = undefined;
		this.#setState("disabled");
		return this.#disposeOwnedConnections();
	}

	async dispose(): Promise<void> {
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

	markToolsChanged(): void {
		this.#emit(this.#toolsListeners, {
			type: "tools_changed",
			serverName: this.serverName,
			generation: this.#generation,
		});
	}

	onStateChange(listener: Listener<ServerConnectionStateChangedEvent>): () => void {
		this.#stateListeners.add(listener);
		return () => this.#stateListeners.delete(listener);
	}

	onToolsChanged(listener: Listener<ServerConnectionToolsChangedEvent>): () => void {
		this.#toolsListeners.add(listener);
		return () => this.#toolsListeners.delete(listener);
	}

	#createTransportConnection(generation: number): McpTransportConnection {
		const connection = createMcpTransport({
			config: this.#config,
			env: this.#env,
			logger: this.#logger,
			serverName: this.serverName,
		});
		connection.transport.onclose = wrapAsync(
			"connection.transport.onclose",
			() => {
				if (this.#shutdownConnections.has(connection)) return;
				if (generation === this.#generation && this.#state !== "disabled") {
					this.markDegraded(this.#connectError(`MCP server ${this.serverName} transport closed`, "close", true));
				}
			},
			this.#sink,
		);
		return connection;
	}

	async #connectTransport(connection: McpTransportConnection, generation: number): Promise<Client> {
		try {
			await connectMcpTransport(connection);
		} catch (error) {
			if (this.#pendingConnection === connection) this.#pendingConnection = undefined;
			await this.#shutdown(connection);
			if (generation !== this.#generation || this.#state === "disabled") {
				throw this.#connectError(`MCP server ${this.serverName} connect was superseded`, "connect", true);
			}
			const normalized = error instanceof Error ? error : new Error(String(error));
			this.markDegraded(normalized);
			throw normalized;
		}
		if (generation !== this.#generation || this.#state === "disabled") {
			await this.#shutdown(connection);
			throw this.#connectError(`MCP server ${this.serverName} connect was superseded`, "connect", true);
		}
		if (this.#pendingConnection === connection) this.#pendingConnection = undefined;
		this.#connection = connection;
		this.#lastError = undefined;
		this.#setState("connected");
		this.markToolsChanged();
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

	#emit<TEvent>(listeners: Set<Listener<TEvent>>, event: TEvent): void {
		for (const listener of listeners) {
			void wrapAsync("connection.event", listener, this.#sink)(event);
		}
	}

	#markFailure(state: ServerConnectionState, error: Error | undefined): void {
		this.#lastError = error;
		this.#setState(state, error);
	}

	#connectError(message: string, phase: string, retriable?: true): ConnectError {
		return new ConnectError(message, { phase, retriable, serverName: this.serverName });
	}

	get #sink(): McpAsyncErrorSink {
		return { logger: this.#logger };
	}
}
