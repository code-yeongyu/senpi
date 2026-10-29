import type { EventLeases } from "./compact-event-leases.ts";
import { randomInt } from "node:crypto";
import type { RecoveryRepairAdvice } from "@earendil-works/pi-protocol";
import { CompactStorageReadError } from "./compact-storage-io.ts";
import { CompactReadError } from "./compact-read-lease.ts";
import { storageUnavailable } from "./compact-recovery-types.ts";
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

/** A request refused before any lease is looked at: RULING-81 Q-A (a checkpoint has its own release) or malformed. */
function refused(
	id: string | undefined,
	type: string,
	reason: "lease_kind_unsupported" | "malformed_request",
): RpcResponse {
	const failure = { kind: "request_refused", reason, hint: "new_request" } as const;
	return error(id, type, codeOf(failure), { ...failure });
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
	const lane = writer.recoveryLane(caller.sessionId);
	let outcome: Awaited<ReturnType<RecoveryPageRequests["request"]>>;
	try {
		outcome = await pages.request(caller, command);
	} catch (cause) {
		if (!(cause instanceof CompactStorageReadError || cause instanceof CompactReadError)) throw cause;
		outcome = { ok: false, failure: storageUnavailable("unavailable") } as const;
	}
	// Foreign/unknown tokens learn no source identity or storage counter (RULING-56).
	const source =
		!outcome.ok && (outcome.failure.kind === "request_refused" || outcome.failure.reason === "unknown_token")
			? undefined
			: lane;
	let healthRevision: string | null = null;
	try {
		if (source) healthRevision = await source.staging.store.health.revision();
	} catch (cause) {
		if (!(cause instanceof Error)) throw cause;
		outcome = { ok: false, failure: storageUnavailable("unavailable") } as const;
	}
	const failure = outcome.ok ? undefined : outcome.failure;
	if (failure?.kind === "request_refused") return error(id, type, codeOf(failure), { ...failure });
	const repair: RecoveryRepairAdvice = {
		state: failure?.kind ?? "ok",
		healthRevision,
		source: source ? { sessionEpoch: source.sessionEpoch, sequence: source.acceptedSequence } : null,
		hint: "restart_from_catalog",
		retryAfterMs: outcome.ok ? 0 : randomInt(100, 2_001),
	};
	const ordinary = writer.ordinaryRoute(writer.currentConnection() ?? "", caller.sessionId);
	const generation =
		outcome.ok && "generation" in outcome.value
			? outcome.value.generation
			: ordinary?.routes.includes(command.admissionId)
				? ordinary.generation
				: undefined;
	if (outcome.ok)
		return {
			id,
			type: "response",
			command: type,
			success: true,
			...(generation !== undefined
				? { sessionId: caller.sessionId, admissionId: command.admissionId, generation }
				: {}),
			data: { ...outcome.value, repair },
		};
	return error(id, type, codeOf(outcome.failure), { ...outcome.failure, repair });
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
	const kind: unknown = lease?.kind;
	if (kind === "checkpoint") return refused(id, type, "lease_kind_unsupported");
	if (kind !== "event" || typeof lease?.id !== "string" || typeof admissionId !== "string")
		return refused(id, type, "malformed_request");
	const outcome = events.release(caller, lease.id, admissionId);
	if (outcome.ok) return { id, type: "response", command: type, success: true, data: outcome.value };
	return error(id, type, codeOf(outcome.failure), { ...outcome.failure });
}
