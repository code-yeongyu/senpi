/**
 * What the receiving device records for a move it was offered, how a record is read back from disk or from the wire,
 * and the refusal a move gets once its record no longer lets it land.
 */
import type { MoveId } from "./ownership.ts";

export type DeclineReason = "no_record" | "expired" | "cancelled" | "chunk_without_ready" | "repository";
export type FailReason = "bundle_invalid" | "import_failed";

/** The answers a sender can hear. */
export type MoveStatus =
	| { readonly state: "receiving" }
	| { readonly state: "accepted" }
	| { readonly state: "declined"; readonly reason: DeclineReason }
	| { readonly state: "failed"; readonly reason: FailReason };

/**
 * A status answer as the sender hears it. `revoked` marks an accepted import the receiver later sealed with `revoke`:
 * the record stays `accepted` (final), but the receiver's copy is read-only, so the sender must take the session back.
 */
export type MoveAnswer = MoveStatus | { readonly state: "accepted"; readonly revoked: true };

/** `ready`: this device told the sender it can take the move; no bundle has been verified yet. */
export type MoveRecord = MoveAnswer | { readonly state: "ready"; readonly expiresAt: string };

export class MoveFencedError extends Error {
	readonly code = "move_fenced";
	readonly record: MoveRecord | undefined;

	constructor(moveId: MoveId, record: MoveRecord | undefined, detail?: string) {
		super(
			`Move ${moveId} can no longer be imported here: ${detail ?? `it was already answered (${record?.state ?? "no record"})`}.`,
		);
		this.name = "MoveFencedError";
		this.record = record;
	}
}

const DECLINE_REASONS: readonly DeclineReason[] = [
	"no_record",
	"expired",
	"cancelled",
	"chunk_without_ready",
	"repository",
];
const FAIL_REASONS: readonly FailReason[] = ["bundle_invalid", "import_failed"];

/** A receiver's answer as it arrives back at the sender; a `ready` record is not an answer. */
export function parseMoveStatus(value: unknown): MoveAnswer | undefined {
	const record = parseRecord(value);
	return record?.state === "ready" ? undefined : record;
}

export function parseRecord(value: unknown): MoveRecord | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { state, reason } = value as { readonly state?: unknown; readonly reason?: unknown };
	if (state === "accepted" && (value as { readonly revoked?: unknown }).revoked === true)
		return { state, revoked: true };
	if (state === "receiving") return { state };
	if (state === "accepted") return { state };
	const { expiresAt } = value as { readonly expiresAt?: unknown };
	if (state === "ready" && typeof expiresAt === "string" && !Number.isNaN(Date.parse(expiresAt)))
		return { state, expiresAt };
	const decline = DECLINE_REASONS.find((known) => known === reason);
	if (state === "declined" && decline !== undefined) return { state, reason: decline };
	const fail = FAIL_REASONS.find((known) => known === reason);
	if (state === "failed" && fail !== undefined) return { state, reason: fail };
	return undefined;
}
