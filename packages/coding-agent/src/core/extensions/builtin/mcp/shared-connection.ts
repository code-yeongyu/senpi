import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { collectServerCatalogForCache, type McpCachedServerCatalog, writeMcpCachedServer } from "./catalog-cache.ts";
import { ServerConnection } from "./connection.ts";
import type { ServerConnectionOptions } from "./connection-types.ts";
import { MCP_KEEP_ALIVE_INTERVAL_MS } from "./idle.ts";
import type { McpLogger } from "./log.ts";
import { configureMcpReconnect, disposeMcpReconnect } from "./reconnect.ts";
import { ensureMcpResourceSubscriptions } from "./resources.ts";
import { SharedMcpLease } from "./shared-lease.ts";
import { safeInterval, safeTimer } from "./wrap.ts";

export interface SharedMcpOptions extends ServerConnectionOptions {
	readonly agentDir: string;
	readonly configHash: string;
}

/** Owns one SDK handler set, reconnect loop, cache writer and aggregate lifetime. */
export class SharedMcpConnection {
	readonly connection: ServerConnection;
	readonly leases = new Set<SharedMcpLease>();
	readonly #calls = new Map<SharedMcpLease, number>();
	readonly #options: SharedMcpOptions;
	readonly #onDispose: () => void;
	#idleTimeoutMin: number;
	#idleTimer: NodeJS.Timeout | undefined;
	#keepAliveTimer: NodeJS.Timeout | undefined;
	#catalog: Promise<McpCachedServerCatalog> | undefined;
	#cacheGeneration = -1;
	#renewing: Promise<Client> | undefined;
	#disposed = false;
	#inFlight = 0;

	constructor(options: SharedMcpOptions, onDispose: () => void) {
		this.#options = options;
		this.#onDispose = onDispose;
		this.#idleTimeoutMin = options.config.idleTimeoutMin;
		const multicast = (method: "debug" | "info" | "warn" | "error" | "stderr", message: string, data?: unknown) => {
			for (const lease of this.leases) lease.options.logger[method](message, data);
		};
		const logger: McpLogger = {
			filePath: options.logger.filePath,
			debug: (message, data) => multicast("debug", message, data),
			info: (message, data) => multicast("info", message, data),
			warn: (message, data) => multicast("warn", message, data),
			error: (message, data) => multicast("error", message, data),
			stderr: (message, data) => multicast("stderr", message, data),
			log: (level, message, data, channel) => {
				for (const lease of this.leases) lease.options.logger.log(level, message, data, channel);
			},
			getRingBuffer: () => options.logger.getRingBuffer(),
		};
		this.connection = new ServerConnection({
			...options,
			logger,
			elicitationUiProvider: () => {
				// SDK server requests carry no originating tool-call id.
				const owners = [...this.#calls.keys()];
				return owners.length === 1 && this.leases.has(owners[0])
					? owners[0].options.elicitationUiProvider?.()
					: undefined;
			},
		});
		this.connection.onToolsChanged(() => {
			this.#catalog = undefined;
		});
		this.connection.onStateChange((event) => {
			if (event.state !== "connected" || options.config.type !== "http") return;
			const client = this.connection.client;
			const onerror = client.onerror;
			client.onerror = (error) => {
				onerror?.(error);
				logger.debug("Shared MCP transport error", { error, cause: error.cause });
				const cause = error.cause;
				const socketLost =
					typeof cause === "object" &&
					cause !== null &&
					"code" in cause &&
					(cause.code === "ECONNRESET" || cause.code === "ECONNREFUSED" || cause.code === "UND_ERR_SOCKET");
				// The SDK reports a broken SSE socket through onerror, not onclose.
				// Let the host renew once; disposal cancels the SDK's old SSE retry.
				if (
					this.connection.state === "connected" &&
					this.connection.client === client &&
					(socketLost ||
						error.message.startsWith("SSE stream disconnected:") ||
						error.message.startsWith("Failed to reconnect SSE stream:"))
				) {
					this.connection.markDegraded(error);
				}
			};
		});
		configureMcpReconnect({
			connection: this.connection,
			logger,
			shouldReconnect: () => !this.#disposed && (this.leases.size > 0 || this.#calls.size > 0),
			reconnect: async () => {
				await this.#renew();
			},
		});
	}

	attach(options: ServerConnectionOptions, owner: object, key: string): SharedMcpLease {
		this.#clearIdle();
		const lease = new SharedMcpLease(this, options, owner, key);
		this.leases.add(lease);
		this.#idleTimeoutMin = Math.max(...[...this.leases].map((item) => item.options.config.idleTimeoutMin));
		this.#refreshKeepAlive();
		return lease;
	}

	connect(): Promise<Client> {
		if (this.#renewing !== undefined) return this.#renewing;
		if (["connected", "connecting", "idle"].includes(this.connection.state)) {
			return this.runRequest(() => this.connection.connect());
		}
		return this.runRequest(() => this.#renew());
	}

	async runRequest<T>(call: () => Promise<T>): Promise<T> {
		this.#clearIdle();
		this.#inFlight++;
		try {
			return await call();
		} finally {
			this.#inFlight--;
			this.#armIdle();
		}
	}

	async callTool<T>(lease: SharedMcpLease, call: () => Promise<T>): Promise<T> {
		this.#clearIdle();
		this.#calls.set(lease, (this.#calls.get(lease) ?? 0) + 1);
		try {
			return await this.runRequest(call);
		} finally {
			const count = (this.#calls.get(lease) ?? 1) - 1;
			if (count === 0) this.#calls.delete(lease);
			else this.#calls.set(lease, count);
			this.#armIdle();
		}
	}

	release(lease: SharedMcpLease): void {
		// Capture the last attached policy before removing the final owner.
		this.#idleTimeoutMin = Math.max(...[...this.leases].map((item) => item.options.config.idleTimeoutMin));
		this.leases.delete(lease);
		this.#refreshKeepAlive();
		this.#armIdle();
	}

	async catalog(refresh = false): Promise<McpCachedServerCatalog> {
		await this.connect();
		if (refresh) this.#catalog = undefined;
		this.#catalog ??= this.runRequest(() => this.#collectCatalog());
		return this.#catalog;
	}

	async #collectCatalog(): Promise<McpCachedServerCatalog> {
		const generation = this.connection.generation;
		const ownsCatalog = () =>
			generation === this.connection.generation &&
			!this.#disposed &&
			[...this.leases].some((lease) => lease.options.credentialsCurrent?.() !== false);
		const catalog = await collectServerCatalogForCache(
			this.connection,
			this.#options.config,
			this.#options.configHash,
			this.#options.credentialIdentity,
		);
		if (!ownsCatalog()) return catalog;
		if (this.#cacheGeneration !== generation) {
			this.#cacheGeneration = generation;
			await writeMcpCachedServer(this.#options.agentDir, this.#options.serverName, catalog, ownsCatalog);
		}
		if (ownsCatalog()) await ensureMcpResourceSubscriptions(this.connection.client, catalog.resources);
		return catalog;
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#clearIdle();
		clearInterval(this.#keepAliveTimer);
		disposeMcpReconnect(this.connection);
		for (const lease of [...this.leases]) await lease.dispose();
		this.#onDispose();
		await this.connection.dispose();
	}

	#renew(): Promise<Client> {
		this.#renewing ??= this.connection.renew().finally(() => {
			this.#renewing = undefined;
		});
		return this.#renewing;
	}

	#armIdle(): void {
		if (this.#disposed || this.leases.size > 0 || this.#inFlight > 0 || this.#idleTimer !== undefined) return;
		this.#idleTimer = safeTimer("mcp.shared.idle", this.#idleTimeoutMin * 60_000, () => this.dispose(), {
			logger: this.#options.logger,
		});
	}

	#clearIdle(): void {
		clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
	}

	#refreshKeepAlive(): void {
		const keepAlive = [...this.leases].some((lease) => lease.options.config.lifecycle === "keep-alive");
		if (!keepAlive || this.#disposed) {
			clearInterval(this.#keepAliveTimer);
			this.#keepAliveTimer = undefined;
		} else if (this.#keepAliveTimer === undefined) {
			this.#keepAliveTimer = safeInterval(
				"mcp.shared.keepAlive",
				MCP_KEEP_ALIVE_INTERVAL_MS,
				async () => {
					if (this.connection.state === "connected") await this.connection.client.ping({ timeout: 2_000 });
					else await this.connect();
				},
				{ logger: this.#options.logger },
			);
		}
	}
}
