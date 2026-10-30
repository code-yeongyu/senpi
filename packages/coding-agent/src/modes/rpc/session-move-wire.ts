import type { MoveAnswer } from "../../core/session-move/move-ledger.ts";

/** Capability: the host answers `move_session` (senpi#3676). */
export const MOVE_SESSION_CAPABILITY = "move_session";
/** Capability: `move_session` answers op `revoke`, which seals a copy this host imported (senpi#4003). */
export const MOVE_SESSION_REVOKE_CAPABILITY = "move_session_revoke";

/** A `move_session` request whose fields do not parse (op, move id, paths, answer). */
export const RPC_ERROR_INVALID_MOVE_REQUEST = "invalid_move_request";
/** `export` of a session this host still has open: release it with `release_session` reason `move` first. */
export const RPC_ERROR_SESSION_OPEN_HERE = "session_open_here";
/** `export` of a session file that is not sealed for this move by a `release_session` reason `move`. */
export const RPC_ERROR_MOVE_NOT_RELEASED = "move_not_released";
/** A move step that failed for a reason with no code of its own; `errorData.detail` says what happened. */
export const RPC_ERROR_MOVE_FAILED = "move_failed";

/**
 * Drives one step of moving a session between devices. The transport carries bundles and answers between hosts; every
 * decision about the session file is taken here. Sender: `export` (after `release_session` reason `move`) and
 * `finish`. Receiver: `prepare`, `cancel`, `import`, `status`, and `revoke` once the sender took the session back.
 */
export type RpcMoveSessionCommand = { id?: string; type: "move_session" } & (
	| { op: "prepare"; moveId: string }
	| { op: "cancel"; moveId: string }
	| { op: "status"; moveId: string; sessionPath?: string }
	| { op: "export"; sessionPath: string; moveId: string; target: string; droppedUserMessages?: string[] }
	| { op: "import"; bundleDir: string; cwd: string; from?: string }
	| { op: "finish"; sessionPath: string; moveId: string; answer: MoveAnswer }
	| { op: "revoke"; sessionPath: string; moveId: string }
);

/** The receiver's record of a move as a client sees it; `expires_at` while it waits for the bundle. */
export type RpcMoveRecord = MoveAnswer | { state: "ready"; expires_at: string };

export type RpcMoveSessionData =
	| RpcMoveRecord
	| { move_id: string; session_id: string; bundle_dir: string; files: number }
	| { session_id: string; session_path: string }
	| { ownership: "writable" | "moving" | "moved" };

export interface RpcMoveSessionResponse {
	id?: string;
	type: "response";
	command: "move_session";
	success: true;
	data: RpcMoveSessionData;
}
