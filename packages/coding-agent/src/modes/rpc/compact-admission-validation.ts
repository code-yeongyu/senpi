import { compactUpdatesEnabled } from "../../core/engine-socket-flag.ts";
import { parseBoundedId } from "./compact-recovery-ids.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import { error } from "./session-router-errors.ts";

/** RULING-85 Q2: a present malformed ID is never an implicit legacy request. */
export function invalidCompactAdmission(command: RpcCommand): RpcResponse | undefined {
	if (
		!compactUpdatesEnabled() ||
		!["open_session", "subscribe_sessions", "get_recovery_page", "cancel_attempt", "reset_stream"].includes(
			command.type,
		)
	)
		return undefined;
	if (command.type !== "cancel_attempt" && command.type !== "reset_stream" && !("admissionId" in command))
		return undefined;
	const id: unknown = "admissionId" in command ? command.admissionId : undefined;
	if (typeof id === "string" && parseBoundedId(id).ok) return undefined;
	return error(command.id, command.type, "admission_malformed_request", {
		kind: "request_refused",
		reason: "malformed_request",
		hint: "new_request",
	});
}
