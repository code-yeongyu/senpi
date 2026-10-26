/**
 * The per-session transfer seal (code-yeongyu/oh-my-openagent#10091, strict session transfer). A drain
 * that is about to hand a quiet session to the next generation seals it in the same synchronous step as
 * its final quiet check, before any await. From then on a command that would add work to the session is
 * answered `session_closing` with the transfer it is waiting on, never admitted into a queue that is being
 * closed; reads, aborts, answers to a pending question and the session's own lifecycle commands still pass.
 * A transfer that cannot finish unseals the session, which then admits work again on this generation.
 */
import { randomUUID } from "node:crypto";
import { RPC_ERROR_SESSION_CLOSING, type RpcCommand, type RpcResponse } from "./rpc-types.ts";
import { READ_ONLY_OR_CONTROL } from "./session-held.ts";
import type { RouterContext } from "./session-router-context.ts";
import { error } from "./session-router-errors.ts";
import type { TransferBlocker } from "./session-transfer-quiescence.ts";

export interface TransferSeal {
	readonly transferId: string;
	/** Set by an explicit `close_session` that arrived during the transfer: the close wins, nothing reopens. */
	closed: boolean;
}

const LIFECYCLE_PASSING_THE_SEAL: ReadonlySet<string> = new Set([
	"close_session",
	"release_attachment",
	"attach_session",
	"reclaim_session",
]);

export const TRANSFER_ADMISSION_CLOSED =
	"this session is being handed to the next host generation; deliver there instead (admission is closed here)";

/** Seals `sessionId` for one transfer; `undefined` when a transfer of it is already in progress. */
export function sealTransfer(host: RouterContext, sessionId: string): TransferSeal | undefined {
	if (host.transferSeals.has(sessionId)) return undefined;
	const seal: TransferSeal = { transferId: randomUUID(), closed: false };
	host.transferSeals.set(sessionId, seal);
	host.registry.peek(sessionId)?.runtime?.session.externalAdmission.close(TRANSFER_ADMISSION_CLOSED);
	return seal;
}

/** Ends `seal`; `readmit` reopens the session's admission because it stays on this generation. */
export function unsealTransfer(host: RouterContext, sessionId: string, seal: TransferSeal, readmit: boolean): void {
	if (host.transferSeals.get(sessionId) !== seal) return;
	host.transferSeals.delete(sessionId);
	if (readmit) host.registry.peek(sessionId)?.runtime?.session.externalAdmission.reopen();
}

/** The answer a sealed session gives `command`, or `undefined` when the command passes the seal. */
export function transferSealRefusal(host: RouterContext, command: RpcCommand): RpcResponse | undefined {
	if (!("sessionId" in command) || command.sessionId === undefined) return undefined;
	const seal = host.transferSeals.get(command.sessionId);
	if (seal === undefined || READ_ONLY_OR_CONTROL.has(command.type) || LIFECYCLE_PASSING_THE_SEAL.has(command.type))
		return undefined;
	return error(command.id, command.type, RPC_ERROR_SESSION_CLOSING, {
		reason: "handoff_transfer",
		transfer_id: seal.transferId,
	});
}

/** Logs a held session once per change of what holds it, and forgets the sessions no longer held. */
export function reportHeldTransfers(host: RouterContext, held: ReadonlyMap<string, readonly TransferBlocker[]>): void {
	for (const [sessionId, blockers] of held) {
		const reason = blockers.join(",");
		if (host.heldTransfers.get(sessionId) === reason) continue;
		host.heldTransfers.set(sessionId, reason);
		process.stderr.write(`senpi rpc handoff keeps session ${sessionId} on this generation: ${reason}\n`);
	}
	for (const sessionId of [...host.heldTransfers.keys()])
		if (!held.has(sessionId)) host.heldTransfers.delete(sessionId);
}
