/**
 * `move_session` op `import` (senpi#3676, senpi#6267): the bundle comes as the folder the transport wrote or inline in
 * the request, the session lands in this host's session folder for `cwd` or in the one the caller names, and with
 * `open` the landed session is opened in the same answer.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { getDefaultSessionDir, loadEntriesFromFileAsync } from "../../core/session-manager.ts";
import { importMovedSession } from "../../core/session-move/import.ts";
import { withStagedInlineBundle } from "../../core/session-move/inline-bundle.ts";
import type { MoveLedger } from "../../core/session-move/move-ledger.ts";
import { headerSessionId } from "../../core/session-move/ownership.ts";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import type { MoveRequest } from "./session-move-request.ts";
import type { RpcMoveImportData, RpcMoveImportOpen, RpcMoveOpenError } from "./session-move-wire.ts";
import type { OpenReplyAs } from "./session-router-open-result.ts";

export interface MoveImportPort {
	/** This host's agent directory: the move folders live under `<agentDir>/session-moves`. */
	readonly agentDir: string;
	/**
	 * The open an `import` asks for with `open`: what an `open_session` for the landed file from the importing
	 * connection would do. On success the open queues `reply` as the import's answer, with the open's data beside it,
	 * and resolves `undefined`; otherwise it resolves the open's failure response and queues nothing.
	 */
	open(command: Extract<RpcCommand, { type: "open_session" }>, reply: OpenReplyAs): Promise<RpcResponse | undefined>;
}

/**
 * Why a `sessionDir` cannot hold the session, when a file is in its place or above it: a request error, asked before
 * the import touches the move, so the move stays importable. `undefined` for a folder and for a path not there yet.
 */
export async function sessionDirRefusal(sessionDir: string | undefined): Promise<string | undefined> {
	if (sessionDir === undefined) return undefined;
	const found = await stat(normalizePath(sessionDir)).then(
		(entry) => (entry.isDirectory() ? "folder" : "file"),
		(cause: unknown) =>
			typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOTDIR" ? "file" : "absent",
	);
	return found === "file" ? "sessionDir must be a folder: a file is in its place or above it." : undefined;
}

/** An inline bundle is staged in this host's own folder under `root`, then read exactly as a folder is. */
export async function importMoved(
	parsed: Extract<MoveRequest, { op: "import" }>,
	port: MoveImportPort,
	ledger: MoveLedger,
	root: string,
): Promise<RpcMoveImportData> {
	const cwd = resolvePath(parsed.cwd);
	const landing = {
		targetCwd: cwd,
		ledger,
		sessionDir:
			parsed.sessionDir === undefined ? getDefaultSessionDir(cwd, port.agentDir) : normalizePath(parsed.sessionDir),
		from: parsed.from,
	};
	const { sessionFile } =
		"dir" in parsed.bundle
			? await importMovedSession({ ...landing, bundleDir: normalizePath(parsed.bundle.dir) })
			: await withStagedInlineBundle(parsed.bundle.files, join(root, "incoming"), (bundleDir, sent) =>
					importMovedSession({ ...landing, bundleDir, sent }),
				);
	const sessionId = headerSessionId(await loadEntriesFromFileAsync(sessionFile));
	if (sessionId === undefined) throw new Error(`The imported session at ${sessionFile} has no id in its header.`);
	return { session_id: sessionId, session_path: sessionFile };
}

/**
 * Opens the session an import landed, in the folder the import named (`cwd`): an open that names no folder runs in
 * the host's own, whatever the landed file's header says (senpi#6427). `undefined` means the open queued the import's
 * answer itself; otherwise the open failed, which never undoes the import: the move stands, and the caller opens the
 * session with `open_session`.
 */
export async function openLanded(
	port: MoveImportPort,
	id: string | undefined,
	open: true | RpcMoveImportOpen,
	cwd: string,
	landed: RpcMoveImportData,
): Promise<RpcMoveOpenError | undefined> {
	const failure = await port
		.open(
			{
				...(open === true ? {} : open),
				type: "open_session",
				sessionPath: landed.session_path,
				cwd: resolvePath(cwd),
			},
			{ command: { type: "move_session", id }, data: landed },
		)
		.catch((cause: unknown): RpcMoveOpenError => ({ error: cause instanceof Error ? cause.message : String(cause) }));
	if (failure === undefined || !("success" in failure)) return failure;
	if (failure.success) return undefined;
	return {
		error: failure.error,
		...(failure.errorCode === undefined ? {} : { errorCode: failure.errorCode }),
		...(failure.errorData === undefined ? {} : { errorData: failure.errorData }),
	};
}
