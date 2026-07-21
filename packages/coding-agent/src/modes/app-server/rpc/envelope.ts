export type RpcRequestId = string | number;
export type RpcResponseId = RpcRequestId | null;

export type RpcRequest = {
	readonly id: RpcRequestId;
	readonly method: string;
	readonly params?: unknown;
};

export type RpcError = {
	readonly code: number;
	readonly message: string;
	readonly data?: unknown;
};

export type RpcSuccessResponse = {
	readonly id: RpcResponseId;
	readonly result: unknown;
};

export type RpcErrorResponse = {
	readonly id: RpcResponseId;
	readonly error: RpcError;
};

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse;

export type RpcNotification = {
	readonly method: string;
	readonly params?: unknown;
	readonly emittedAtMs?: number;
};

export type RpcEnvelope = RpcRequest | RpcResponse | RpcNotification;

export type PopulatedRpcNotification = RpcNotification & { readonly emittedAtMs: number };

export type ClassifiedIncoming =
	| { readonly kind: "request"; readonly message: RpcRequest }
	| { readonly kind: "response"; readonly message: RpcResponse }
	| { readonly kind: "notification"; readonly message: RpcNotification }
	| { readonly kind: "protocol-invalid"; readonly value: unknown };

type JsonObject = {
	readonly [key: string]: unknown;
	readonly code?: unknown;
	readonly data?: unknown;
	readonly error?: unknown;
	readonly id?: unknown;
	readonly message?: unknown;
	readonly method?: unknown;
	readonly params?: unknown;
	readonly result?: unknown;
};

export function populateNotificationEnvelope(
	notification: RpcNotification,
	emittedAtMs?: number,
): PopulatedRpcNotification {
	return { ...notification, emittedAtMs: notification.emittedAtMs ?? emittedAtMs ?? Date.now() };
}

export function populateOutboundNotificationEnvelope(message: RpcEnvelope, emittedAtMs?: number): RpcEnvelope {
	return isRpcNotification(message) ? populateNotificationEnvelope(message, emittedAtMs) : message;
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcNotification(message: RpcEnvelope): message is RpcNotification {
	return "method" in message && !("id" in message);
}

function hasOwn(value: JsonObject, key: string): boolean {
	return Reflect.getOwnPropertyDescriptor(value, key) !== undefined;
}

function isRequestId(value: unknown): value is RpcRequestId {
	return typeof value === "string" || typeof value === "number";
}

function isResponseId(value: unknown): value is RpcResponseId {
	return value === null || isRequestId(value);
}

function parseRpcError(value: unknown): RpcError | null {
	if (!isJsonObject(value)) {
		return null;
	}

	const code = value.code;
	const message = value.message;
	if (typeof code !== "number" || typeof message !== "string") {
		return null;
	}

	if (hasOwn(value, "data")) {
		return { code, message, data: value.data };
	}
	return { code, message };
}

function requestFrom(value: JsonObject, id: RpcRequestId, method: string): RpcRequest {
	if (hasOwn(value, "params")) {
		return { id, method, params: value.params };
	}
	return { id, method };
}

function notificationFrom(value: JsonObject, method: string): RpcNotification {
	if (hasOwn(value, "params")) {
		return { method, params: value.params };
	}
	return { method };
}

export function classifyIncoming(value: unknown): ClassifiedIncoming {
	if (!isJsonObject(value)) {
		return { kind: "protocol-invalid", value };
	}

	const id = value.id;
	const method = value.method;
	if (hasOwn(value, "id") && hasOwn(value, "method") && isRequestId(id) && typeof method === "string") {
		return { kind: "request", message: requestFrom(value, id, method) };
	}

	if (hasOwn(value, "id") && isResponseId(id) && hasOwn(value, "result")) {
		return { kind: "response", message: { id, result: value.result } };
	}

	if (hasOwn(value, "id") && isResponseId(id) && hasOwn(value, "error")) {
		const error = parseRpcError(value.error);
		if (error !== null) {
			return { kind: "response", message: { id, error } };
		}
	}

	if (!hasOwn(value, "id") && hasOwn(value, "method") && typeof method === "string") {
		return { kind: "notification", message: notificationFrom(value, method) };
	}

	return { kind: "protocol-invalid", value };
}
