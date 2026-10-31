/**
 * Who may write a session file when sessions move between devices (sisyphuslabs/omo-desktop-app#3137,
 * senpi#3630). The file itself records ownership as a sequence of transitions, folded in order:
 * - writable (no ownership entry yet, a `takeover` release, `session_moved_in`, `session_reclaimed`);
 * - `moving` after a `move` release: only that move may continue, with `session_moved` (it arrived),
 *   `session_reclaimed` (it was given back) or `session_moved_in` (an import of that same move);
 * - `moved` after `session_moved`: nothing may reopen it. A new move id arriving by import replaces the file.
 * A transition the current state does not allow is refused when written and ignored when read. Entries name the
 * session they belong to (`session_id`); a copy or branch under a new id ignores the entries it inherited.
 */

/** `customType` of the release entry; shared with `release_session` (`modes/rpc/session-release.ts`). */
export const SESSION_RELEASED = "session_released";
export const SESSION_MOVED_IN = "session_moved_in";
export const SESSION_MOVED = "session_moved";
export const SESSION_RECLAIMED = "session_reclaimed";

export type MoveId = string & { readonly __brand: "MoveId" };

export type RefusedOwnership =
	| { readonly writable: false; readonly state: "moving"; readonly moveId: MoveId; readonly target: string }
	| { readonly writable: false; readonly state: "moved"; readonly moveId: MoveId; readonly target: string };

export type SessionOwnership = { readonly writable: true } | RefusedOwnership;

export type OwnershipStep =
	| { readonly kind: "none" }
	| { readonly kind: "apply"; readonly next: SessionOwnership }
	| { readonly kind: "refused" };

interface EntryLike {
	readonly type: string;
	readonly customType?: string;
	readonly data?: unknown;
	readonly id?: unknown;
}

const WRITABLE: SessionOwnership = { writable: true };
const NONE: OwnershipStep = { kind: "none" };
const REFUSED: OwnershipStep = { kind: "refused" };

const OWNERSHIP_TYPES: ReadonlySet<string> = new Set([
	SESSION_RELEASED,
	SESSION_MOVED_IN,
	SESSION_MOVED,
	SESSION_RECLAIMED,
]);

export function isOwnershipEntryType(customType: string | undefined): boolean {
	return customType !== undefined && OWNERSHIP_TYPES.has(customType);
}

function field(data: unknown, key: string): string | undefined {
	if (typeof data !== "object" || data === null) return undefined;
	const value = (data as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

function requested(entry: EntryLike): SessionOwnership {
	const moveId = (field(entry.data, "move_id") ?? "") as MoveId;
	const target = field(entry.data, "target") ?? "";
	if (entry.customType === SESSION_MOVED) return { writable: false, state: "moved", moveId, target };
	if (entry.customType === SESSION_RELEASED && field(entry.data, "reason") === "move")
		return { writable: false, state: "moving", moveId, target };
	return WRITABLE;
}

/**
 * The single transition rule. `sessionId` is the id of the session being written; an entry naming another session
 * (inherited by a copy or branch) is not an ownership step for this one.
 */
export function ownershipStep(
	current: SessionOwnership,
	entry: EntryLike,
	sessionId: string | undefined,
): OwnershipStep {
	if (entry.type !== "custom" || !isOwnershipEntryType(entry.customType)) return NONE;
	const owner = field(entry.data, "session_id");
	if (owner !== undefined && sessionId !== undefined && owner !== sessionId) return NONE;
	const next = requested(entry);
	if (current.writable) return { kind: "apply", next };
	if (current.state === "moved") return REFUSED;
	const sameMove = field(entry.data, "move_id") === current.moveId;
	const continuesMove =
		entry.customType === SESSION_MOVED ||
		entry.customType === SESSION_RECLAIMED ||
		entry.customType === SESSION_MOVED_IN;
	return sameMove && continuesMove ? { kind: "apply", next } : REFUSED;
}

export function headerSessionId(entries: readonly EntryLike[]): string | undefined {
	const header = entries.find((entry) => entry.type === "session");
	return typeof header?.id === "string" ? header.id : undefined;
}

export function sessionOwnership(entries: readonly EntryLike[]): SessionOwnership {
	const sessionId = headerSessionId(entries);
	let verdict = WRITABLE;
	for (const entry of entries) {
		const step = ownershipStep(verdict, entry, sessionId);
		if (step.kind === "apply") verdict = step.next;
	}
	return verdict;
}

export class SessionMovedAwayError extends Error {
	readonly code = "session_moved_away";
	readonly ownership: RefusedOwnership;

	constructor(sessionFile: string, ownership: RefusedOwnership) {
		const where = ownership.target === "" ? "another device" : ownership.target;
		super(
			ownership.state === "moving"
				? `This session is being moved to ${where}; it is read-only here. Wait for the move to finish, or make a copy to keep working here. (${sessionFile})`
				: `This session was moved to ${where}; it is read-only here. Open it on ${where}, or make a copy here. (${sessionFile})`,
		);
		this.name = "SessionMovedAwayError";
		this.ownership = ownership;
	}
}
