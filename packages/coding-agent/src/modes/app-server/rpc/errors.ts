import type { CodexErrorInfo as FacadeCodexErrorInfo } from "../protocol/terminal.ts";

export interface JsonRpcError {
	readonly code: number;
	readonly message: string;
	readonly data?: unknown;
}

export type NonSteerableTurnKind = "review" | "compact";

export type CodexErrorInfo =
	| { readonly kind: "contextWindowExceeded" }
	| { readonly kind: "sessionBudgetExceeded" }
	| { readonly kind: "usageLimitExceeded" }
	| { readonly kind: "serverOverloaded" }
	| { readonly kind: "cyberPolicy" }
	| { readonly kind: "httpConnectionFailed"; readonly httpStatusCode: number | null }
	| { readonly kind: "responseStreamConnectionFailed"; readonly httpStatusCode: number | null }
	| { readonly kind: "internalServerError" }
	| { readonly kind: "unauthorized" }
	| { readonly kind: "badRequest" }
	| { readonly kind: "threadRollbackFailed" }
	| { readonly kind: "sandboxError" }
	| { readonly kind: "responseStreamDisconnected"; readonly httpStatusCode: number | null }
	| { readonly kind: "responseTooManyFailedAttempts"; readonly httpStatusCode: number | null }
	| { readonly kind: "activeTurnNotSteerable"; readonly turnKind: NonSteerableTurnKind }
	| { readonly kind: "other" };

export type SerializedCodexErrorInfo = FacadeCodexErrorInfo;

export const codexErrorInfo = {
	contextWindowExceeded: (): CodexErrorInfo => ({ kind: "contextWindowExceeded" }),
	sessionBudgetExceeded: (): CodexErrorInfo => ({ kind: "sessionBudgetExceeded" }),
	usageLimitExceeded: (): CodexErrorInfo => ({ kind: "usageLimitExceeded" }),
	serverOverloaded: (): CodexErrorInfo => ({ kind: "serverOverloaded" }),
	cyberPolicy: (): CodexErrorInfo => ({ kind: "cyberPolicy" }),
	httpConnectionFailed: (httpStatusCode?: number): CodexErrorInfo => ({
		kind: "httpConnectionFailed",
		httpStatusCode: httpStatusCode ?? null,
	}),
	responseStreamConnectionFailed: (httpStatusCode?: number): CodexErrorInfo => ({
		kind: "responseStreamConnectionFailed",
		httpStatusCode: httpStatusCode ?? null,
	}),
	internalServerError: (): CodexErrorInfo => ({ kind: "internalServerError" }),
	unauthorized: (): CodexErrorInfo => ({ kind: "unauthorized" }),
	badRequest: (): CodexErrorInfo => ({ kind: "badRequest" }),
	threadRollbackFailed: (): CodexErrorInfo => ({ kind: "threadRollbackFailed" }),
	sandboxError: (): CodexErrorInfo => ({ kind: "sandboxError" }),
	responseStreamDisconnected: (httpStatusCode?: number): CodexErrorInfo => ({
		kind: "responseStreamDisconnected",
		httpStatusCode: httpStatusCode ?? null,
	}),
	responseTooManyFailedAttempts: (httpStatusCode?: number): CodexErrorInfo => ({
		kind: "responseTooManyFailedAttempts",
		httpStatusCode: httpStatusCode ?? null,
	}),
	activeTurnNotSteerable: (turnKind: NonSteerableTurnKind): CodexErrorInfo => ({
		kind: "activeTurnNotSteerable",
		turnKind,
	}),
	other: (): CodexErrorInfo => ({ kind: "other" }),
} as const;

export function serializeCodexErrorInfo(info: CodexErrorInfo): SerializedCodexErrorInfo {
	switch (info.kind) {
		case "contextWindowExceeded":
		case "sessionBudgetExceeded":
		case "usageLimitExceeded":
		case "serverOverloaded":
		case "cyberPolicy":
		case "internalServerError":
		case "unauthorized":
		case "badRequest":
		case "threadRollbackFailed":
		case "sandboxError":
		case "other":
			return info.kind;
		case "httpConnectionFailed":
			return { httpConnectionFailed: { httpStatusCode: info.httpStatusCode } };
		case "responseStreamConnectionFailed":
			return { responseStreamConnectionFailed: { httpStatusCode: info.httpStatusCode } };
		case "responseStreamDisconnected":
			return { responseStreamDisconnected: { httpStatusCode: info.httpStatusCode } };
		case "responseTooManyFailedAttempts":
			return { responseTooManyFailedAttempts: { httpStatusCode: info.httpStatusCode } };
		case "activeTurnNotSteerable":
			return { activeTurnNotSteerable: { turnKind: info.turnKind } };
		default:
			return assertNever(info);
	}
}

export function parseError(): JsonRpcError {
	return { code: -32700, message: "Parse error" };
}

/**
 * Base class for handler-thrown errors that carry an intended JSON-RPC error
 * payload. The method registry returns `rpcError` verbatim instead of masking
 * the failure as a -32603 internal error.
 */
export class RpcHandlerError extends Error {
	readonly rpcError: JsonRpcError;

	constructor(error: JsonRpcError) {
		super(error.message);
		this.name = "RpcHandlerError";
		this.rpcError = error;
	}
}

export function invalidRequestError(): JsonRpcError {
	return { code: -32600, message: "Invalid request" };
}

export function methodNotFoundError(method: string): JsonRpcError {
	return { code: -32601, message: `Method not found: ${method}` };
}

export function invalidParamsError(): JsonRpcError {
	return { code: -32602, message: "Invalid params" };
}

export function internalError(message = "Internal error"): JsonRpcError {
	return { code: -32603, message };
}

export function overloadedError(): JsonRpcError {
	return { code: -32001, message: "Server overloaded; retry later." };
}

export function notInitializedError(): JsonRpcError {
	return { code: -32600, message: "Not initialized" };
}

export function alreadyInitializedError(): JsonRpcError {
	return { code: -32600, message: "Already initialized" };
}

export function experimentalCapabilityError(method: string): JsonRpcError {
	return { code: -32600, message: `${method} requires experimentalApi capability` };
}

function assertNever(value: never): never {
	throw new Error(`Unhandled CodexErrorInfo variant: ${JSON.stringify(value)}`);
}
