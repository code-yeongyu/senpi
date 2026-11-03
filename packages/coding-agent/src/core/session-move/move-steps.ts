/**
 * The durable steps of a session move on one device, in order (senpi#4004). Each row says what is on disk and what the
 * receiver's move record says right after that step, and what a crash there (the process dies) or a throw there (the
 * step's caller sees an error) must leave. Three rules hold after every row:
 * - at most one copy of the session is writable, across the sender's file and every receiver folder;
 * - the move record agrees with the files: `status` answers what the files prove, never a stale or contradicting state;
 * - a revoke mark, once the copy is sealed, is never lost.
 *
 * The code calls `moveStep(row.step)` right after each durable step; a test sets a hook there to stand for a crash or
 * a throw, and `rpc-move-session-steps.test.ts` drives one injection per row. Unset outside tests, so a no-op.
 */
export const MOVE_STEPS = [
	{
		step: "import:received",
		flow: "import",
		disk: "the bundle is verified; nothing has landed in the session folder",
		record: "receiving, with the landing target recorded",
		after: "nothing landed: status answers receiving; an import into the same folder lands it, any other folder is fenced",
	},
	{
		step: "import:stamped",
		flow: "import",
		disk: "nothing has landed yet; the staged copy is ready",
		record: "receiving, target recorded, stamped committing",
		after: "a move lands once, so every import is fenced; status checks the target: no file there means failed (the sender takes the session back)",
	},
	{
		step: "import:renamed",
		flow: "import",
		disk: "the copy landed at the target, writable, recording session_moved_in",
		record: "still receiving and stamped committing",
		after: "status and a same-file import confirm the landed file (accepted); a failure here never records failed; any other folder is fenced",
	},
	{
		step: "import:accepted",
		flow: "import",
		disk: "the copy landed at the target",
		record: "accepted, target recorded (final)",
		after: "the import is done; a crash or throw after it changes nothing",
	},
	{
		step: "revoke:sealed",
		flow: "revoke",
		disk: "the receiver's copy records session_moved reason revoked: read-only",
		record: "accepted, not yet marked revoked",
		after: "status reads the sealed file and answers revoked, writing the mark; a repeated revoke writes it too; never plain accepted",
	},
	{
		step: "revoke:marked",
		flow: "revoke",
		disk: "the receiver's copy is sealed",
		record: "accepted and revoked",
		after: "the revoke is done",
	},
	{
		step: "finish:recorded",
		flow: "finish",
		disk: "the sender's file records session_moved (moved) or session_reclaimed (taken back); its bundle is kept",
		record: "unchanged (the sender's side)",
		after: "a repeated finish re-queues the dropped input once (stable ids) and then removes the bundle",
	},
	{
		step: "finish:requeued",
		flow: "finish",
		disk: "the dropped input is queued again on a taken-back file; the bundle is still there",
		record: "unchanged (the sender's side)",
		after: "a repeated finish finds the input already queued and removes the bundle",
	},
] as const;

export type MoveStep = (typeof MOVE_STEPS)[number]["step"];

let hook: ((step: MoveStep) => void) | undefined;

/** Test seam: the hook runs right after each durable step; throwing from it stands for a crash or a throw there. */
export function setMoveStepHook(next: ((step: MoveStep) => void) | undefined): void {
	hook = next;
}

export function moveStep(step: MoveStep): void {
	hook?.(step);
}
