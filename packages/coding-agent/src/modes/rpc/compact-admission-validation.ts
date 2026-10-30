import { compactUpdatesEnabled } from "../../core/engine-socket-flag.ts";
import { CompactAdmissionError } from "./compact-admission-error.ts";
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
export function unknownCompactAdmission(
	host: RouterContext,
	command: RpcCommand,
): RpcResponse | undefined | Promise<RpcResponse | undefined> {
	if (!host.admissions || command.admissionId === undefined) return undefined;
	// These commands introduce client IDs; their bounded attempt index owns retry/conflict/retirement.
	if (command.type === "open_session" || command.type === "attach_session" || command.type === "subscribe_sessions")
		return undefined;
	// RULING-96: recovery IDs select token/lease authority, not the ordinary attempt ledger.
	if (command.type === "get_recovery_page" || command.type === "release_recovery") return undefined;
	const admissionId = command.admissionId;
	const peer = host.writer.currentConnection();
	const epoch = peer === undefined ? undefined : host.writer.socketEpochOf(peer);
	const held =
		peer !== undefined &&
		host.writer.holdsAdmission(peer, admissionId, "sessionId" in command ? command.sessionId : undefined);
	if (held) return undefined;
	const refusal: RpcResponse = {
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
	// Only an unaccepted producer needs an async index read; every other route stays synchronous.
	return command.type === "cancel_attempt" && epoch !== undefined
		? host.admissions.pending(epoch, admissionId).then(
				(pending) => (pending ? undefined : refusal),
				(cause: unknown) => {
					if (!(cause instanceof CompactAdmissionError)) throw cause;
					return error(command.id, command.type, `admission_${cause.reason}`, {
						kind: "request_refused",
						reason: cause.reason,
						hint: "new_request",
					});
				},
			)
		: refusal;
}
