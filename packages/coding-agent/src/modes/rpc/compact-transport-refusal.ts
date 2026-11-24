import { RPC_ERROR_FEATURE_DISABLED } from "./rpc-error-types.ts";
import type { RpcResponse } from "./rpc-types.ts";
import { error } from "./session-router-errors.ts";

/**
 * The compact engine-socket transport's public methods (senpi#5748). They are always in the method table; on a
 * connection without the compact transport (compact updates off, or the classic stdio handler) each answers this one
 * typed refusal, never "Unknown command".
 */
export const COMPACT_TRANSPORT_METHODS: ReadonlySet<string> = new Set([
	"reset_stream",
	"cancel_attempt",
	"get_recovery_page",
	"release_recovery",
]);

/** `feature_disabled` with `errorData.feature: "compact_updates"`, keeping the `sessionId` a session reply carries. */
export function compactTransportDisabled(command: {
	readonly id?: string;
	readonly type: string;
	readonly sessionId?: string;
}): RpcResponse {
	const refusal = error(command.id, command.type, RPC_ERROR_FEATURE_DISABLED, { feature: "compact_updates" });
	if (command.sessionId === undefined) return refusal;
	// Tagged like a session's own reply (session-event-writer-lifecycle.ts), so the refusal keeps the shape it had.
	const tagged = { ...refusal, sessionId: command.sessionId };
	return tagged;
}
