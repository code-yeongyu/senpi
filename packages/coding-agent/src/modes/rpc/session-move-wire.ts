import type { MoveAnswer } from "../../core/session-move/move-ledger.ts";

/** Capability: the host answers `move_session` (senpi#3676). */
export const MOVE_SESSION_CAPABILITY = "move_session";
/** Capability: `move_session` answers op `revoke`, which seals a copy this host imported (senpi#4003). */
export const MOVE_SESSION_REVOKE_CAPABILITY = "move_session_revoke";
/** Capability: `move_session` answers op `copy`, which copies a session into a new one under a given id (senpi#5889). */
export const MOVE_SESSION_COPY_CAPABILITY = "move_session_copy";
/**
 * Capability: `status` for an accepted move, and an `import` refused because the move already landed, answer where it
 * landed (senpi#6436).
 */
export const MOVE_SESSION_STATUS_LANDED_PATH_CAPABILITY = "move_session_status_landed_path";
/**
 * Capability: `status` takes `landing`, the place the move would have landed, and answers from the session file there
 * before it answers from its record. A move that landed and whose record was lost then answers `accepted`.
 */
export const MOVE_SESSION_STATUS_LANDING_CAPABILITY = "move_session_status_landing";

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
 * `finish`. Receiver: `prepare`, `cancel`, `import`, `status`, and `revoke` once the sender took the session back. Either
 * side: `copy`, a new writable session from one that is read-only here.
 */
export type RpcMoveSessionCommand = { id?: string; type: "move_session" } & (
	| { op: "prepare"; moveId: string }
	| { op: "cancel"; moveId: string }
	| { op: "status"; moveId: string; sessionPath?: string; landing?: RpcMoveStatusLanding }
	| { op: "export"; sessionPath: string; moveId: string; target: string; droppedUserMessages?: string[] }
	| { op: "import"; bundleDir: string; cwd: string; from?: string }
	| { op: "finish"; sessionPath: string; moveId: string; answer: MoveAnswer }
	| { op: "revoke"; sessionPath: string; moveId: string }
	| { op: "copy"; sessionPath: string; sessionId: string; sessionDir?: string }
);

/**
 * Where a move would have landed, as a `status` may name it in place of `sessionPath`: the folder the import was
 * given, the session file name the bundle's manifest carries, and the session folder the import named, if it named one.
 */
export interface RpcMoveStatusLanding {
	cwd: string;
	sessionFileName: string;
	sessionDir?: string;
}

/**
 * Where an accepted move landed: the session file its record names, with the id and the folder that file's header
 * names. `landed_file: "gone"` when no file is there or the file there no longer records the move.
 */
export type RpcMoveLanded = { session_path: string; session_id: string; cwd: string } | { landed_file: "gone" };

/**
 * The receiver's record of a move as a client sees it; `expires_at` while it waits for the bundle, and where it landed
 * beside `accepted` (absent when the record names no landing target).
 */
export type RpcMoveRecord =
	| MoveAnswer
	| (Extract<MoveAnswer, { state: "accepted" }> & RpcMoveLanded)
	| { state: "ready"; expires_at: string };

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
