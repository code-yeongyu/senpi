/**
 * A project write may state the folder its caller means (`expectedCwd`). A client that reaches a session by a key that
 * can since name another session (a remote desktop, through a relay) states it, so the write lands only in the project
 * it means: when the session's working directory is another folder, the write is refused and nothing is written.
 * Absent, the write goes as it always has.
 */
import { RPC_ERROR_PROJECT_CWD_MISMATCH } from "./rpc-error-types.ts";

/** The project writes that may state the folder they mean. */
const PROJECT_WRITES: ReadonlySet<string> = new Set(["set_project_trust", "set_project_setting", "write_project_file"]);

/**
 * A folder path for comparison: trailing separators of the path's own style dropped (only `/` for a POSIX path; `\\` or
 * `/` for a drive or UNC path); a bare root stays itself. Nothing is trimmed: on POSIX `"/w/app "` and `"/w/app\\"` are
 * other directories than `"/w/app"`.
 */
export function comparableFolder(path: string): string {
	if (path.startsWith("/")) return path.replace(/\/+$/u, "") || "/";
	return path.replace(/[/\\]+$/u, "");
}

export interface CwdMismatch {
	readonly message: string;
	readonly errorCode: typeof RPC_ERROR_PROJECT_CWD_MISMATCH;
}

/** The refusal of a project write whose stated folder is not the session's, or undefined when it may go. */
export function projectCwdMismatch(
	command: { readonly type: string; readonly expectedCwd?: unknown },
	sessionCwd: string,
): CwdMismatch | undefined {
	if (!PROJECT_WRITES.has(command.type) || typeof command.expectedCwd !== "string") return undefined;
	if (comparableFolder(command.expectedCwd) === comparableFolder(sessionCwd)) return undefined;
	return {
		message: "This session is in another folder than the one this write is for; nothing was written.",
		errorCode: RPC_ERROR_PROJECT_CWD_MISMATCH,
	};
}
