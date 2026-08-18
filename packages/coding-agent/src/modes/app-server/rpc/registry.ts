import {
	alreadyInitializedError,
	experimentalCapabilityError,
	internalError,
	type JsonRpcError,
	methodNotFoundError,
	notInitializedError,
	RpcHandlerError,
} from "./errors.ts";

export type RequestId = string | number | null;

export interface RpcRequest {
	readonly id: RequestId;
	readonly method: string;
	readonly params?: unknown;
}

export type RpcResponse =
	| { readonly id: RequestId; readonly result: unknown }
	| { readonly id: RequestId; readonly error: JsonRpcError };

export interface ConnectionCapabilities {
	readonly experimentalApi?: boolean;
}

export interface RegistryConnection {
	readonly initialized: boolean;
	readonly capabilities?: ConnectionCapabilities;
}

export type MethodScope = "thread" | "global" | "none";

export interface MethodHandlerContext {
	readonly connection: RegistryConnection;
	readonly request: RpcRequest;
}

export type MethodHandler = (context: MethodHandlerContext) => Promise<unknown> | unknown;

export interface MethodRegistration {
	readonly handler: MethodHandler;
	readonly experimental?: boolean;
	readonly requiresInit?: boolean;
	readonly scope?: MethodScope;
}

export interface MethodRegistry {
	register(method: string, registration: MethodRegistration): void;
	dispatch(connection: RegistryConnection, request: RpcRequest): Promise<RpcResponse>;
}

export interface ExtensionRequestTarget {
	readonly extensionRunner: {
		requestRpc(name: string, data: unknown): Promise<unknown>;
	};
}

export function registerExtensionRequestMethod(
	registry: MethodRegistry,
	getThread: (threadId: string) => ExtensionRequestTarget,
): void {
	registry.register("extension_request", {
		scope: "thread",
		handler: async ({ request }) => {
			const params = request.params;
			if (typeof params !== "object" || params === null || Array.isArray(params)) {
				throw new RpcHandlerError({ code: -32602, message: "Invalid params" });
			}
			const threadId = Reflect.get(params, "threadId");
			const name = Reflect.get(params, "name");
			if (typeof threadId !== "string" || threadId.length === 0 || typeof name !== "string" || name.length === 0) {
				throw new RpcHandlerError({ code: -32602, message: "Invalid params" });
			}
			try {
				return await getThread(threadId).extensionRunner.requestRpc(name, Reflect.get(params, "data"));
			} catch (error) {
				throw new RpcHandlerError(internalError(error instanceof Error ? error.message : String(error)));
			}
		},
	});
}

export function createRegistry(): MethodRegistry {
	return new InMemoryMethodRegistry();
}

class InMemoryMethodRegistry implements MethodRegistry {
	private readonly methods = new Map<string, MethodRegistration>();

	register(method: string, registration: MethodRegistration): void {
		this.methods.set(method, registration);
	}

	async dispatch(connection: RegistryConnection, request: RpcRequest): Promise<RpcResponse> {
		if (!connection.initialized) {
			const registration = this.methods.get(request.method);
			if (request.method !== "initialize" || registration?.requiresInit !== false) {
				return { id: request.id, error: notInitializedError() };
			}
		}

		if (connection.initialized && request.method === "initialize") {
			return { id: request.id, error: alreadyInitializedError() };
		}

		const registration = this.methods.get(request.method);
		if (!registration) {
			return { id: request.id, error: methodNotFoundError(request.method) };
		}

		if (registration.experimental === true && connection.capabilities?.experimentalApi !== true) {
			return { id: request.id, error: experimentalCapabilityError(request.method) };
		}

		try {
			const result = await registration.handler({ connection, request });
			return { id: request.id, result };
		} catch (error) {
			if (error instanceof RpcHandlerError) {
				return { id: request.id, error: error.rpcError };
			}
			return { id: request.id, error: internalError(error instanceof Error ? error.message : String(error)) };
		}
	}
}
