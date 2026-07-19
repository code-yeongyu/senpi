import { AsyncLocalStorage } from "node:async_hooks";
import { getAgentDir, VERSION } from "../../../config.ts";
import {
	type ClassifiedIncoming,
	populateNotificationEnvelope,
	type RpcNotification,
	type RpcRequest,
	type RpcResponse,
} from "../rpc/envelope.ts";
import { alreadyInitializedError, invalidParamsError, invalidRequestError } from "../rpc/errors.ts";
import { createRegistry, type MethodRegistration, type MethodRegistry } from "../rpc/registry.ts";
import {
	buildInitializeResponse,
	type Connection,
	type ConnectionId,
	type ConnectionInput,
	canDeliverNotification,
	createConnection,
	parseInitializeParams,
} from "./connection.ts";
import { type AppServerModelRegistry, registerAppServerModelMethods } from "./models.ts";

export interface ServerCoreOptions {
	readonly registry?: MethodRegistry;
	readonly modelRegistry?: AppServerModelRegistry;
	readonly codexHome?: string;
	readonly version?: string;
	readonly now?: () => number;
}

export type DeferredResponseAction = () => Promise<void> | void;

/** Mutable action queue owned by exactly one in-flight request dispatch. */
type DeferredDispatch = {
	readonly connectionId: ConnectionId;
	readonly actions: DeferredResponseAction[];
};

export class ServerCore {
	private readonly connections = new Map<ConnectionId, Connection>();
	private readonly registry: MethodRegistry;
	private readonly codexHome: string;
	private readonly version: string;
	private readonly now: () => number;
	private readonly activeDispatch = new AsyncLocalStorage<DeferredDispatch>();

	constructor(options: ServerCoreOptions = {}) {
		this.registry = options.registry ?? createRegistry();
		this.codexHome = options.codexHome ?? getAgentDir();
		this.version = options.version ?? VERSION;
		this.now = options.now ?? Date.now;
		registerAppServerModelMethods(this.registry, {
			modelRegistry: options.modelRegistry,
			agentDir: this.codexHome,
		});
	}

	addConnection(input: ConnectionInput): Connection {
		const connection = createConnection(input);
		this.connections.set(connection.id, connection);
		return connection;
	}

	removeConnection(id: ConnectionId): void {
		this.connections.delete(id);
	}

	getConnection(id: ConnectionId): Connection | undefined {
		return this.connections.get(id);
	}

	registerMethod(method: string, registration: MethodRegistration): void {
		this.registry.register(method, registration);
	}

	deferUntilResponded(connectionId: ConnectionId, action: DeferredResponseAction): boolean {
		const dispatch = this.activeDispatch.getStore();
		if (dispatch?.connectionId !== connectionId || !this.connections.has(connectionId)) {
			return false;
		}
		dispatch.actions.push(action);
		return true;
	}

	async receive(connectionId: ConnectionId, envelope: ClassifiedIncoming): Promise<void> {
		const connection = this.connections.get(connectionId);
		if (!connection) {
			return;
		}

		switch (envelope.kind) {
			case "request":
				await this.respondToRequest(connection, envelope.message);
				return;
			case "notification":
				this.handleNotification(envelope.message);
				return;
			case "response":
				return;
			case "protocol-invalid":
				await connection.send({ id: null, error: invalidRequestError() });
				return;
			default:
				return assertNever(envelope);
		}
	}

	async sendNotificationToConnection(connectionId: ConnectionId, notification: RpcNotification): Promise<boolean> {
		const connection = this.connections.get(connectionId);
		if (!connection || !canDeliverNotification(connection, notification)) {
			return false;
		}
		await connection.send(populateNotificationEnvelope(notification, this.now()));
		return true;
	}

	async broadcastNotification(notification: RpcNotification): Promise<number> {
		let delivered = 0;
		const envelope = populateNotificationEnvelope(notification, this.now());
		for (const connection of this.connections.values()) {
			if (canDeliverNotification(connection, envelope)) {
				await connection.send(envelope);
				delivered += 1;
			}
		}
		return delivered;
	}

	private async respondToRequest(connection: Connection, request: RpcRequest): Promise<void> {
		const dispatch: DeferredDispatch = { connectionId: connection.id, actions: [] };
		const response = await this.activeDispatch.run(dispatch, () => this.dispatchRequest(connection, request));
		try {
			await connection.send(response);
		} catch (error) {
			dispatch.actions.length = 0;
			throw error;
		}

		if ("error" in response || this.connections.get(connection.id) !== connection) {
			dispatch.actions.length = 0;
			return;
		}

		const actions = dispatch.actions.splice(0);
		for (const action of actions) {
			await action();
		}
	}

	private async dispatchRequest(connection: Connection, request: RpcRequest): Promise<RpcResponse> {
		if (request.method === "initialize") {
			return this.handleInitialize(connection, request);
		}
		return this.registry.dispatch(connection, request);
	}

	private handleInitialize(connection: Connection, request: RpcRequest): RpcResponse {
		if (connection.initialized) {
			return { id: request.id, error: alreadyInitializedError() };
		}

		const params = parseInitializeParams(request.params);
		if (!params) {
			return { id: request.id, error: invalidParamsError() };
		}

		const initialized = connection.initialize(params, this.version);
		switch (initialized.kind) {
			case "initialized":
				return { id: request.id, result: buildInitializeResponse(connection, this.codexHome) };
			case "already-initialized":
				return { id: request.id, error: alreadyInitializedError() };
			default:
				return assertNever(initialized);
		}
	}

	private handleNotification(notification: RpcNotification): void {
		if (notification.method === "initialized") {
			return;
		}
	}
}

function assertNever(value: never): never {
	throw new Error(`Unhandled app-server envelope kind: ${JSON.stringify(value)}`);
}
