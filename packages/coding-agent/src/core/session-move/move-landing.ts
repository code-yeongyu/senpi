import { MOVE_RECORD_LOCK_STALE_MS } from "./move-ledger-lock.ts";
import type { MoveRecord } from "./move-record.ts";

/**
 * How old a commit stamp with no landed file must be before it is settled as failed (senpi#6417). A commit holds its
 * record's lock from its stamp to its rename, so a stamp with no file, read under that lock, was left by a commit that
 * failed, died, or stalled until its lock went stale and was taken over. Only a stalled one can still rename, when it
 * runs again; this gives it three stale bounds to land its file or to learn that its lock is gone.
 */
export const COMMIT_SETTLE_AFTER_MS = 3 * MOVE_RECORD_LOCK_STALE_MS;

/** How long ago a record was written, from its `at`; `undefined` when it carries none. */
export function recordAge(value: unknown, now: number): number | undefined {
	if (typeof value !== "object" || value === null || !("at" in value) || typeof value.at !== "string")
		return undefined;
	const at = Date.parse(value.at);
	return Number.isNaN(at) ? undefined : now - at;
}

/** Whether a stored record is still the commit stamp that was written at `stamp`. */
export function isCommitStamp(value: unknown, stamp: string): boolean {
	if (typeof value !== "object" || value === null || !("at" in value)) return false;
	return value.at === stamp && parseLanding(value).committing === true;
}

/** What the session file at a move's landing target records for the move. */
export type LandingOutcome = "absent" | "moved_in" | "revoked";

/** The hidden part of a move record: where the move lands, and whether its commit began. Never part of an answer. */
export interface Landing {
	readonly target?: string;
	readonly committing?: true;
}

export function parseLanding(value: unknown): Landing {
	if (typeof value !== "object" || value === null) return {};
	const { target, committing } = value as { target?: unknown; committing?: unknown };
	return {
		...(typeof target === "string" ? { target } : {}),
		...(committing === true ? { committing: true } : {}),
	};
}

/**
 * What a record becomes once the file at its target settles a step a crash interrupted: a committing record is
 * accepted (revoked if the file is) when its file landed and failed when it did not, and an accepted record whose file
 * is sealed gains its revoke mark. `undefined` when the record already agrees with the file, and while a commit stamp
 * with no file is younger than `COMMIT_SETTLE_AFTER_MS` (`stampAge`; a stamp with no known age counts as old).
 */
export function settledLanding(
	record: MoveRecord | undefined,
	committing: boolean,
	outcome: LandingOutcome,
	stampAge?: number,
): MoveRecord | undefined {
	if (record?.state === "receiving" && committing) {
		if (outcome === "absent")
			return stampAge !== undefined && stampAge < COMMIT_SETTLE_AFTER_MS
				? undefined
				: { state: "failed", reason: "import_failed" };
		return outcome === "revoked" ? { state: "accepted", revoked: true } : { state: "accepted" };
	}
	if (record?.state === "accepted" && !("revoked" in record) && outcome === "revoked")
		return { state: "accepted", revoked: true };
	return undefined;
}

/** Whether an import into `target` may proceed: only a receiving move whose commit has not begun, into its target. */
export function landsAt(record: MoveRecord | undefined, landing: Landing, target: string): boolean {
	return record?.state === "receiving" && landing.committing !== true && landing.target === target;
}

export function landedElsewhere(record: MoveRecord | undefined, landing: Landing): string | undefined {
	const stored = landing.target;
	if (record?.state === "accepted" && "revoked" in record) return "it was revoked here and never lands again";
	if (record?.state === "receiving" && landing.committing === true)
		return "an import of it stopped mid-commit, and a move lands once; only the file it landed is accepted";
	if (record?.state === "accepted")
		return "it already landed here once, and a move lands once (a deleted copy is gone; copy the session to a new thread instead)";
	if (record?.state === "receiving" && stored === undefined)
		return "an older version started receiving it and where it landed is unknown; only its already landed file is accepted";
	return stored === undefined ? undefined : `it lands only as ${stored}`;
}
