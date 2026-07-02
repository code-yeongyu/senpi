import { getAgentDir, VERSION } from "../../../config.ts";
import type { ClassifiedIncoming, RpcNotification, RpcRequest, RpcResponse } from "../rpc/envelope.ts";
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

export interface ServerCoreOptions {
	readonly registry?: MethodRegistry;
	readonly codexHome?: string;
	readonly version?: string;
}

export class ServerCore {
	private readonly connections = new Map<ConnectionId, Connection>();
	private readonly registry: MethodRegistry;
	private readonly codexHome: string;
	private readonly version: string;

	constructor(options: ServerCoreOptions = {}) {
		this.registry = options.registry ?? createRegistry();
		this.codexHome = options.codexHome ?? getAgentDir();
		this.version = options.version ?? VERSION;
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

	async receive(connectionId: ConnectionId, envelope: ClassifiedIncoming): Promise<void> {
		const connection = this.connections.get(connectionId);
		if (!connection) {
			return;
		}

		switch (envelope.kind) {
			case "request":
				await connection.send(await this.dispatchRequest(connection, envelope.message));
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
		await connection.send(notification);
		return true;
	}

	async broadcastNotification(notification: RpcNotification): Promise<number> {
		let delivered = 0;
		for (const connection of this.connections.values()) {
			if (canDeliverNotification(connection, notification)) {
				await connection.send(notification);
				delivered += 1;
			}
		}
		return delivered;
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

		connection.initialize(params, this.version);
		return { id: request.id, result: buildInitializeResponse(connection, this.codexHome) };
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
