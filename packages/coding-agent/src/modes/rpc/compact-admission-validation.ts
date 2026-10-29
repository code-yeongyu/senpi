import { compactUpdatesEnabled } from "../../core/engine-socket-flag.ts";
import { parseBoundedId } from "./compact-recovery-ids.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import type { RouterContext } from "./session-router-context.ts";
import { error } from "./session-router-errors.ts";

/** RULING-85 Q2: a present malformed ID is never an implicit legacy request. */
export function invalidCompactAdmission(command: RpcCommand): RpcResponse | undefined {
	if (!compactUpdatesEnabled()) return undefined;
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

/** RULING-94: only the server-side caller's authority is examined, before any command side effect. */
export async function unknownCompactAdmission(
	host: RouterContext,
	command: RpcCommand,
): Promise<RpcResponse | undefined> {
	if (!host.admissions || command.admissionId === undefined) return undefined;
	// These commands introduce client IDs; their bounded attempt index owns retry/conflict/retirement.
	if (command.type === "open_session" || command.type === "subscribe_sessions") return undefined;
	const admissionId = command.admissionId;
	const peer = host.writer.currentConnection();
	const epoch = peer === undefined ? undefined : host.writer.socketEpochOf(peer);
	const held =
		peer !== undefined &&
		host.writer.holdsAdmission(peer, admissionId, "sessionId" in command ? command.sessionId : undefined);
	// A not-yet-accepted open has no route yet, but the caller may cancel its own indexed producer.
	if (
		held ||
		(command.type === "cancel_attempt" && epoch !== undefined && (await host.admissions.pending(epoch, admissionId)))
	)
		return undefined;
	return {
		id: command.id,
		type: "response",
		command: command.type,
		success: false,
		error: "unknown_admission",
		errorCode: "unknown_admission",
		errorData: { code: "unknown_admission", admissionId },
		code: "unknown_admission",
		admissionId,
	};
}
