import type { AgentSession } from "../../core/agent-session.ts";

import type { RpcResponse } from "./rpc-types.ts";
import { RPC_ERROR_OPEN_FAILED, RPC_ERROR_SESSION_CLOSING, RPC_ERROR_UNKNOWN_SESSION } from "./rpc-types.ts";

import { RpcSessionRegistryError } from "./session-registry.ts";

import type { RouterContext } from "./session-router-context.ts";

export function error(
	id: string | undefined,
	command: string,
	code: string,
	data?: Readonly<Record<string, unknown>>,
): RpcResponse {
	// `errorData` carries what a client has to ACT on (who holds a path, when to retry); the
	// stable code stays the string every existing client already switches on.
	return {
		id,
		type: "response",
		command,
		success: false,
		error: code,
		...(data && { errorCode: code, errorData: data }),
	};
}

export function code(cause: unknown): string {
	if (cause instanceof RpcSessionRegistryError) {
		return cause.code === RPC_ERROR_OPEN_FAILED ? cause.message : cause.code;
	}
	if (cause instanceof Error && [RPC_ERROR_UNKNOWN_SESSION, RPC_ERROR_SESSION_CLOSING].includes(cause.message)) {
		return cause.message;
	}
	if (!(cause instanceof Error) || !cause.message) return RPC_ERROR_UNKNOWN_SESSION;
	// A worker relays its own registry's refusal as text that already names the code.
	return cause.message.startsWith(`${RPC_ERROR_OPEN_FAILED}: `)
		? cause.message
		: `${RPC_ERROR_OPEN_FAILED}: ${cause.message}`;
}

/** The machine-readable half of a refusal, when the registry attached one. */
export function detail(cause: unknown): Readonly<Record<string, unknown>> | undefined {
	return cause instanceof RpcSessionRegistryError ? cause.detail : undefined;
}

/** The routing id this host answers `session` on, if it holds it. */
export function routingIdOf(host: RouterContext, session: AgentSession): string | undefined {
	for (const row of host.registry.list()) {
		if (host.registry.peek(row.sessionId)?.runtime?.session === session) return row.sessionId;
	}
	return undefined;
}
