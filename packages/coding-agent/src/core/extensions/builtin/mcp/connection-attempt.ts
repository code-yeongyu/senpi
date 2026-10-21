import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ServerConnectionState } from "./connection-types.ts";
import { ConnectError } from "./errors.ts";
import { type McpTransportConnection, shutdownMcpTransport } from "./transport.ts";

interface ConnectionAttemptOptions {
	readonly serverName: string;
	readonly state: () => ServerConnectionState;
	readonly setState: (state: ServerConnectionState) => void;
	readonly client: () => Client;
	readonly create: () => McpTransportConnection;
	readonly open: (connection: McpTransportConnection, generation: number) => Promise<Client>;
}

/** Physical transport ownership, including the gap between retiring one attempt and opening the next. */
export class McpConnectionAttempt {
	generation = 0;
	connection: McpTransportConnection | undefined;
	pendingConnection: McpTransportConnection | undefined;
	readonly #options: ConnectionAttemptOptions;
	#pendingConnect: Promise<Client> | undefined;
	#renewal: Promise<Client> | undefined;
	#closing: Promise<void> | undefined;
	readonly #shutdowns = new Map<McpTransportConnection, Promise<void>>();

	constructor(options: ConnectionAttemptOptions) {
		this.#options = options;
	}

	connect(): Promise<Client> {
		if (this.#options.state() === "disabled") return this.#disabled("connect");
		return this.#renewal ?? this.#connect();
	}

	renew(): Promise<Client> {
		if (this.#options.state() === "disabled") return this.#disabled("renew");
		if (this.#renewal !== undefined) return this.#renewal;
		// Publish before invalidate emits idle: reentrant and concurrent renewals join this same attempt.
		const renewal = Promise.resolve()
			.then(async () => {
				await this.invalidate("idle");
				return this.#connect();
			})
			.finally(() => {
				if (this.#renewal === renewal) this.#renewal = undefined;
			});
		this.#renewal = renewal;
		return renewal;
	}

	invalidate(state: "idle" | "disabled"): Promise<void> {
		this.generation++;
		this.#pendingConnect = undefined;
		// Install the teardown barrier before idle/disabled listeners can call connect or renew.
		const closing = this.#disposeOwnedConnections();
		if (state === "disabled" || this.#options.state() !== "disabled") this.#options.setState(state);
		return closing;
	}

	isShuttingDown(connection: McpTransportConnection): boolean {
		return this.#shutdowns.has(connection);
	}

	shutdown(connection: McpTransportConnection): Promise<void> {
		const pending = this.#shutdowns.get(connection);
		if (pending !== undefined) return pending;
		const shutdown = shutdownMcpTransport(connection).finally(() => this.#shutdowns.delete(connection));
		this.#shutdowns.set(connection, shutdown);
		return shutdown;
	}

	#connect(): Promise<Client> {
		if (this.#options.state() === "disabled") return this.#disabled("connect");
		if (this.#closing !== undefined) return this.#closing.then(() => this.#connect());
		if (this.#options.state() === "connected") return Promise.resolve(this.#options.client());
		if (this.#pendingConnect !== undefined) return this.#pendingConnect;
		const generation = this.generation;
		let connection: McpTransportConnection;
		try {
			connection = this.#options.create();
		} catch (error) {
			return Promise.reject(error);
		}
		this.pendingConnection = connection;
		this.#pendingConnect = this.#options.open(connection, generation).finally(() => {
			if (this.pendingConnection === connection) this.pendingConnection = undefined;
			if (generation === this.generation) this.#pendingConnect = undefined;
		});
		// Single flight is visible before a connecting listener can reenter.
		if (generation === this.generation) this.#options.setState("connecting");
		return this.#pendingConnect;
	}

	#disposeOwnedConnections(): Promise<void> {
		if (this.#closing !== undefined) return this.#closing;
		// A failed connect drops pendingConnection before its shutdown settles.
		// Those retiring transports still belong to this generation's teardown.
		const connections = new Set(this.#shutdowns.keys());
		if (this.connection !== undefined) connections.add(this.connection);
		if (this.pendingConnection !== undefined) connections.add(this.pendingConnection);
		this.connection = undefined;
		this.pendingConnection = undefined;
		const closing = Promise.resolve()
			.then(() => Promise.all([...connections].map((connection) => this.shutdown(connection))))
			.then(() => undefined)
			.finally(() => {
				if (this.#closing === closing) this.#closing = undefined;
			});
		this.#closing = closing;
		return closing;
	}

	#disabled(phase: string): Promise<never> {
		return Promise.reject(
			new ConnectError(`MCP server ${this.#options.serverName} is disabled`, {
				phase,
				serverName: this.#options.serverName,
			}),
		);
	}
}
