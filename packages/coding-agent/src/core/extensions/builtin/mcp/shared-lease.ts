import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ServerConnection } from "./connection.ts";
import type { ServerConnectionOptions } from "./connection-types.ts";
import { ConnectError } from "./errors.ts";
import type { SharedMcpConnection } from "./shared-connection.ts";

const requestMethods = new Set<PropertyKey>([
	"request",
	"listTools",
	"listResources",
	"listResourceTemplates",
	"listPrompts",
	"readResource",
	"getPrompt",
	"subscribeResource",
	"unsubscribeResource",
	"complete",
	"ping",
	"setLoggingLevel",
]);

/** Session view: only the host can renew/dispose the physical connection. */
export class SharedMcpLease extends ServerConnection {
	readonly owner: object;
	readonly key: string;
	readonly options: ServerConnectionOptions;
	readonly shared: SharedMcpConnection;
	readonly #unsubscribeTools: () => void;
	readonly #stateSubscriptions = new Set<() => void>();
	#released = false;
	#localGeneration = 0;
	#client: Client | undefined;
	#physicalClient: Client | undefined;
	#refreshCatalog = false;

	constructor(shared: SharedMcpConnection, options: ServerConnectionOptions, owner: object, key: string) {
		super(options);
		this.shared = shared;
		this.options = options;
		this.owner = owner;
		this.key = key;
		this.#unsubscribeTools = shared.connection.onToolsChanged((event) => this.markToolsChanged(event.cause));
	}

	override get state() {
		return this.#released ? "disabled" : this.shared.connection.state;
	}
	override get generation() {
		return this.shared.connection.generation + this.#localGeneration;
	}
	override get lastError() {
		return this.shared.connection.lastError;
	}
	override get client(): Client {
		this.#assertAttached();
		const physical = this.shared.connection.client;
		if (this.#physicalClient !== physical) {
			this.#physicalClient = physical;
			const callTool: Client["callTool"] = (...args) => {
				this.#assertAttached();
				return this.shared.callTool(this, () => physical.callTool(...args));
			};
			this.#client = new Proxy(physical, {
				get: (target, property) => {
					if (property === "callTool") return callTool;
					const value = Reflect.get(target, property, target);
					if (typeof value === "function" && requestMethods.has(property)) {
						return (...args: unknown[]) => {
							this.#assertAttached();
							return this.shared.runRequest(() => Promise.resolve(Reflect.apply(value, target, args)));
						};
					}
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		}
		if (this.#client === undefined) throw new ConnectError("MCP client unavailable", { phase: "client" });
		return this.#client;
	}
	override async connect(): Promise<Client> {
		this.#assertAttached();
		await this.shared.connect();
		return this.client;
	}
	override async renew(): Promise<Client> {
		await this.bumpGeneration();
		return this.connect();
	}
	override async bumpGeneration(): Promise<void> {
		this.#assertAttached();
		this.#localGeneration++;
		this.#refreshCatalog = true;
		// Re-list only this owner's catalog; never interrupt another owner's call.
		this.markToolsChanged();
	}
	async catalog() {
		const refresh = this.#refreshCatalog;
		this.#refreshCatalog = false;
		return this.shared.catalog(refresh);
	}
	override getRootPid() {
		return this.#released ? null : this.shared.connection.getRootPid();
	}
	override refreshCapturedDiagnostics() {
		this.shared.connection.refreshCapturedDiagnostics();
	}
	override markDegraded(error: Error) {
		this.shared.connection.markDegraded(error);
	}
	override markSuspended(error?: Error) {
		this.shared.connection.markSuspended(error);
	}
	override markNeedsAuth(error?: Error) {
		this.shared.connection.markNeedsAuth(error);
	}
	override markNeedsClientRegistration(error?: Error) {
		this.shared.connection.markNeedsClientRegistration(error);
	}
	override onStateChange(listener: Parameters<ServerConnection["onStateChange"]>[0]): () => void {
		const off = this.shared.connection.onStateChange((event) => listener({ ...event, generation: this.generation }));
		this.#stateSubscriptions.add(off);
		return () => {
			this.#stateSubscriptions.delete(off);
			off();
		};
	}
	override async disable(): Promise<void> {
		await this.dispose();
	}
	override async dispose(): Promise<void> {
		if (this.#released) return;
		this.#released = true;
		this.#unsubscribeTools();
		for (const off of this.#stateSubscriptions) off();
		this.#stateSubscriptions.clear();
		this.shared.release(this);
	}

	#assertAttached(): void {
		if (this.#released) {
			throw new ConnectError("MCP connection owner detached", { phase: "client", serverName: this.serverName });
		}
	}
}
