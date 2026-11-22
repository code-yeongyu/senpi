import { loadEntriesFromFileAsync, SessionManager } from "../session-manager.ts";
import type { MoveLedger } from "./move-ledger.ts";
import { moveStep } from "./move-steps.ts";
import {
	headerSessionId,
	type MoveId,
	ownershipStep,
	SESSION_MOVED,
	SESSION_MOVED_IN,
	type SessionOwnership,
} from "./ownership.ts";
import { withSessionMoveLock } from "./session-lock.ts";

export interface RevokeMoveOptions {
	/** The copy this device imported for the move. */
	readonly sessionFile: string;
	readonly moveId: MoveId;
	/** This device's move record; its accepted record is marked revoked once the copy is sealed. */
	readonly ledger: MoveLedger;
	/** Runs inside the move lock before anything is read; throw to refuse. */
	readonly guard?: () => void | Promise<void>;
}

export class RevokeMismatchError extends Error {
	readonly code = "move_mismatch";

	constructor(moveId: MoveId) {
		super(
			`This session file is not the copy this device imported for move ${moveId}; nothing was changed. Revoke only the copy that move brought in, with that move's id.`,
		);
		this.name = "RevokeMismatchError";
	}
}

interface EntryLike {
	readonly type: string;
	readonly customType?: string;
	readonly data?: unknown;
	readonly id?: unknown;
}

/** The `session_moved` reason a revoke records. */
export const REVOKED = "revoked";

/**
 * Seals the copy a receiving device imported for a move after the sender took the session back (senpi#4003):
 * `session_moved` with reason `revoked` makes it read-only for good. Only a file whose latest ownership step is this
 * move's `session_moved_in` is revoked; a repeat finds it already revoked and changes nothing. After the seal, under the
 * same lock, the move's accepted record is marked revoked; a repeat writes it again if a crash lost it.
 */
export function revokeImportedMove(options: RevokeMoveOptions): Promise<void> {
	return withSessionMoveLock(
		options.sessionFile,
		async () => {
			await seal(options.sessionFile, options.moveId);
			moveStep("revoke:sealed");
			await options.ledger.markRevoked(options.moveId);
			moveStep("revoke:marked");
		},
		options.guard,
	);
}

async function seal(sessionFile: string, moveId: MoveId): Promise<void> {
	const entries = await loadEntriesFromFileAsync(sessionFile);
	const sessionId = headerSessionId(entries);
	let ownership: SessionOwnership = { writable: true };
	let latest: EntryLike | undefined;
	for (const entry of entries) {
		const step = ownershipStep(ownership, entry, sessionId);
		if (step.kind !== "apply") continue;
		ownership = step.next;
		latest = entry;
	}
	const ofThisMove = latest !== undefined && data(latest, "move_id") === moveId;
	if (ofThisMove && latest?.customType === SESSION_MOVED && data(latest, "reason") === REVOKED) return;
	if (!(ownership.writable && ofThisMove && latest?.customType === SESSION_MOVED_IN))
		throw new RevokeMismatchError(moveId);
	(await SessionManager.openAsync(sessionFile)).appendCustomEntry(SESSION_MOVED, {
		move_id: moveId,
		session_id: sessionId ?? "",
		target: data(latest, "from") ?? "",
		reason: REVOKED,
		moved_at: new Date().toISOString(),
	});
}

function data(entry: EntryLike, key: string): string | undefined {
	if (typeof entry.data !== "object" || entry.data === null) return undefined;
	const value = (entry.data as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}
