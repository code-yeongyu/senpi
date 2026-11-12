import type { RepositoryIdentity } from "../../core/repository-identity.ts";
import type { MoveAnswer } from "../../core/session-move/move-ledger.ts";
import type { RpcCommand } from "./rpc-host-command-types.ts";
import type { RpcSessionPresence } from "./rpc-host-response-types.ts";
import type { RpcSessionState } from "./rpc-session-state-types.ts";

/** What a caller sends and hears for a repository identity; `rootCommits` is mutable as it arrives off the wire. */
export interface RpcRepositoryIdentity {
	rootCommits: string[];
	originUrl?: string;
}

/** Capability: the host answers `move_session` (senpi#3676). */
export const MOVE_SESSION_CAPABILITY = "move_session";
/** Capability: `move_session` answers op `revoke`, which seals a copy this host imported (senpi#4003). */
export const MOVE_SESSION_REVOKE_CAPABILITY = "move_session_revoke";
/** Capability: `move_session` answers op `copy`, which copies a session into a new one under a given id (senpi#5889). */
export const MOVE_SESSION_COPY_CAPABILITY = "move_session_copy";
/** Capability: `export` takes `inline` and answers `inline_files` for a bundle under the cap (senpi#6267). */
export const MOVE_SESSION_EXPORT_INLINE_CAPABILITY = "move_session_export_inline";
/** Capability: `import` takes `files`, an inline bundle, in place of `bundleDir` (senpi#6267). */
export const MOVE_SESSION_IMPORT_FILES_CAPABILITY = "move_session_import_files";
/** Capability: `import` takes `sessionDir`, the folder the session lands in (senpi#6267). */
export const MOVE_SESSION_IMPORT_SESSION_DIR_CAPABILITY = "move_session_import_session_dir";
/** Capability: `import` takes `open` and answers the opened session beside the import (senpi#6267). */
export const MOVE_SESSION_IMPORT_OPEN_CAPABILITY = "move_session_import_open";

/** The most raw bytes, over every file with the manifest, a bundle may hold to travel inline (senpi#6267). */
export const MOVE_INLINE_MAX_BYTES = 1024 * 1024;
/** The most files an inline bundle may list. */
export const MOVE_INLINE_MAX_FILES = 1024;
/** Capability: the inline cap in bytes, as `move_session_inline_max_bytes:<n>`, so a caller can read it (senpi#6267). */
export const MOVE_SESSION_INLINE_MAX_BYTES_CAPABILITY = `move_session_inline_max_bytes:${MOVE_INLINE_MAX_BYTES}`;

/** Capability: `move_session` answers op `identity`, in both its forms, without releasing anything (senpi#6435). */
export const MOVE_SESSION_IDENTITY_CAPABILITY = "move_session_identity";
/** Capability: op `prepare` checks `cwd` against `repository`, and the import lands only there (senpi#6435). */
export const MOVE_SESSION_PREPARE_REPOSITORY_CAPABILITY = "move_session_prepare_repository";

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
	| { op: "prepare"; moveId: string; cwd?: string; repository?: RpcRepositoryIdentity }
	| { op: "identity"; sessionPath: string }
	| { op: "identity"; cwd: string }
	| { op: "cancel"; moveId: string }
	| { op: "status"; moveId: string; sessionPath?: string }
	| {
			op: "export";
			sessionPath: string;
			moveId: string;
			target: string;
			droppedUserMessages?: string[];
			/** Answer the bundle's files as `inline_files` when they fit `inlineMaxBytes` (at most, and by default, the cap). */
			inline?: true;
			inlineMaxBytes?: number;
	  }
	| {
			op: "import";
			cwd: string;
			from?: string;
			/** The bundle: the folder `export` named, or the `inline_files` it answered. Exactly one of the two. */
			bundleDir?: string;
			files?: RpcMoveInlineFile[];
			/** The folder the session lands in; this host's session folder for `cwd` when omitted. */
			sessionDir?: string;
			/** Open the landed session on this connection: `true`, or the `open_session` fields to open it with. */
			open?: true | RpcMoveImportOpen;
	  }
	| { op: "finish"; sessionPath: string; moveId: string; answer: MoveAnswer }
	| { op: "revoke"; sessionPath: string; moveId: string }
	| { op: "copy"; sessionPath: string; sessionId: string; sessionDir?: string }
);

/** One file of an inline bundle: its `/`-separated path in the bundle, the sha256 of its bytes, and the bytes. */
export interface RpcMoveInlineFile {
	path: string;
	sha256: string;
	base64: string;
}

/** The `open_session` fields an `import` may open the landed session with; the import itself names the session file. */
export type RpcMoveImportOpen = Omit<
	Extract<RpcCommand, { type: "open_session" }>,
	"id" | "type" | "sessionPath" | "cwd" | "admissionId"
>;

/**
 * `import`'s data. With `open`, the opened session's `open_session` data sits at the same keys beside it; when the
 * landed session could not be opened, `open_error` carries the failed open's error fields and the import still stands.
 */
export type RpcMoveImportData = {
	session_id: string;
	session_path: string;
	sessionId?: string;
	state?: RpcSessionState;
	attached?: boolean;
	presence?: RpcSessionPresence;
	open_error?: RpcMoveOpenError;
};

export interface RpcMoveOpenError {
	error: string;
	errorCode?: string;
	errorData?: unknown;
}

/** The receiver's record of a move as a client sees it; `expires_at` while it waits for the bundle. */
export type RpcMoveRecord = MoveAnswer | { state: "ready"; expires_at: string };

export type RpcMoveSessionData =
	| RpcMoveRecord
	| { move_id: string; session_id: string; bundle_dir: string; files: number; inline_files?: RpcMoveInlineFile[] }
	| RpcMoveImportData
	| { repository?: RepositoryIdentity }
	| { ownership: "writable" | "moving" | "moved" };

export interface RpcMoveSessionResponse {
	id?: string;
	type: "response";
	command: "move_session";
	success: true;
	data: RpcMoveSessionData;
}
