import type { EventLeases } from "./compact-event-leases.ts";
import type { RecoveryPageFailure, RecoveryPageRequests } from "./compact-recovery-requests.ts";
import type { RecoveryCaller } from "./compact-recovery-types.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import { RPC_ERROR_MISSING_SESSION_ID, RPC_ERROR_UNSUPPORTED_TRANSPORT } from "./rpc-types.ts";
import { error } from "./session-router-errors.ts";
import type { SessionEventWriter } from "./session-event-writer.ts";

type RecoveryPageCommand = Extract<RpcCommand, { type: "get_recovery_page" }>;
type ReleaseRecoveryCommand = Extract<RpcCommand, { type: "release_recovery" }>;

/** The stable error code of each typed refusal; `errorData` carries the refusal itself (kind, reason, hint). */
const codeOf = (failure: RecoveryPageFailure): string =>
	failure.kind === "request_refused" ? `recovery_${failure.reason}` : `recovery_${failure.kind}`;

/**
 * The asking connection's peer incarnation and the command's routing session: the caller the token and lease owners
 * scope every answer to (RULING-56 (1)); a host with no connection identity has no peer to bind them to.
 */
function callerOf(
	writer: SessionEventWriter,
	command: RecoveryPageCommand | ReleaseRecoveryCommand,
): RecoveryCaller | RpcResponse {
	const { id, type, sessionId } = command;
	if (sessionId === undefined) return error(id, type, RPC_ERROR_MISSING_SESSION_ID);
	const connection = writer.currentConnection();
	const socketEpoch = connection === undefined ? undefined : writer.socketEpochOf(connection);
	if (socketEpoch === undefined) return error(id, type, RPC_ERROR_UNSUPPORTED_TRANSPORT);
	return { socketEpoch, sessionId };
}

/** `get_recovery_page` on a socket host (S11b, R4.B3), under a checkpoint token or an event lease (S13). */
export async function answerRecoveryPage(
	pages: RecoveryPageRequests,
	writer: SessionEventWriter,
	command: RecoveryPageCommand,
): Promise<RpcResponse> {
	const caller = callerOf(writer, command);
	if ("type" in caller) return caller;
	const { id, type } = command;
	const outcome = await pages.request(caller, command);
	if (outcome.ok) return { id, type: "response", command: type, success: true, data: outcome.value };
	return error(id, type, codeOf(outcome.failure), { ...outcome.failure });
}

/**
 * `release_recovery` for an event lease (S13, RULING-65 S13-Q2): the consumer's receipt, sent only after it committed
 * the leased content; a retried receipt answers `duplicate` and another peer's or session's lease is `unknown_token`.
 */
export function answerReleaseRecovery(
	events: EventLeases,
	writer: SessionEventWriter,
	command: ReleaseRecoveryCommand,
): RpcResponse {
	const caller = callerOf(writer, command);
	if ("type" in caller) return caller;
	const { id, type, lease, admissionId } = command;
	if (lease?.kind !== "event" || typeof lease.id !== "string" || typeof admissionId !== "string") {
		const failure = { kind: "request_refused", reason: "malformed_request", hint: "new_request" } as const;
		return error(id, type, codeOf(failure), { ...failure });
	}
	const outcome = events.release(caller, lease.id, admissionId);
	if (outcome.ok) return { id, type: "response", command: type, success: true, data: outcome.value };
	return error(id, type, codeOf(outcome.failure), { ...outcome.failure });
}
