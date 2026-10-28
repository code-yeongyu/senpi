import type { RecoveryPageFailure, RecoveryPageRequests } from "./compact-recovery-requests.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import { RPC_ERROR_MISSING_SESSION_ID, RPC_ERROR_UNSUPPORTED_TRANSPORT } from "./rpc-types.ts";
import { error } from "./session-router-errors.ts";
import type { SessionEventWriter } from "./session-event-writer.ts";

type RecoveryPageCommand = Extract<RpcCommand, { type: "get_recovery_page" }>;

/** The stable error code of each typed refusal; `errorData` carries the refusal itself (kind, reason, hint). */
const codeOf = (failure: RecoveryPageFailure): string =>
	failure.kind === "request_refused" ? `recovery_${failure.reason}` : `recovery_${failure.kind}`;

/**
 * `get_recovery_page` on a socket host (S11b, R4.B3): the asking connection's peer incarnation and the command's
 * routing session are the caller the token owner scopes every answer to (RULING-56 (1)); a host with no connection
 * identity has no peer to bind a token or a cursor to.
 */
export async function answerRecoveryPage(
	pages: RecoveryPageRequests,
	writer: SessionEventWriter,
	command: RecoveryPageCommand,
): Promise<RpcResponse> {
	const { id, type, sessionId } = command;
	if (sessionId === undefined) return error(id, type, RPC_ERROR_MISSING_SESSION_ID);
	const connection = writer.currentConnection();
	const socketEpoch = connection === undefined ? undefined : writer.socketEpochOf(connection);
	if (socketEpoch === undefined) return error(id, type, RPC_ERROR_UNSUPPORTED_TRANSPORT);
	const outcome = await pages.request({ socketEpoch, sessionId }, command);
	if (outcome.ok) return { id, type: "response", command: type, success: true, data: outcome.value };
	return error(id, type, codeOf(outcome.failure), { ...outcome.failure });
}
