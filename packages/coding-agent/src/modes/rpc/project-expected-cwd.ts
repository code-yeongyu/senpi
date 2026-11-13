/**
 * A project write may state the folder its caller means (`expectedCwd`). A client that reaches a session by a key that
 * can since name another session (a remote desktop, through a relay) states it, so the write lands only in the project
 * it means: when the session's working directory is another folder, the write is refused and nothing is written.
 * Absent, the write goes as it always has.
 */
import { RPC_ERROR_INVALID_ARGUMENT, RPC_ERROR_PROJECT_CWD_MISMATCH } from "./rpc-error-types.ts";

/** The project writes that may state the folder they mean. */
const PROJECT_WRITES: ReadonlySet<string> = new Set(["set_project_trust", "set_project_setting", "write_project_file"]);

/**
 * A folder path for comparison. Trailing separators of the path's own style are dropped (only `/` for a POSIX path;
 * `\\` or `/` for a drive or UNC path), but a bare root keeps one: `"/"` stays `"/"`, and a bare drive root becomes
 * `X:\\` (`"C:"`, `"C:/"` and `"c:\\"` all become `"C:\\"`). A Windows drive letter is compared without case (`c:` and
 * `C:` are one drive). Nothing else is folded:
 * the rest of the path is compared as written, because whether a file system ignores case depends on the volume and
 * cannot be assumed; and nothing is trimmed, since on POSIX `"/w/app "` and `"/w/app\\"` are other directories.
 */
export function comparableFolder(path: string): string {
	if (path.startsWith("/")) return path.replace(/\/+$/u, "") || "/";
	const hasDrive = /^[A-Za-z]:/u.test(path);
	const folded = hasDrive ? `${path.slice(0, 1).toUpperCase()}${path.slice(1)}` : path;
	const stripped = folded.replace(/[/\\]+$/u, "");
	return hasDrive && stripped.length === 2 ? `${stripped}\\` : stripped;
}

export interface CwdMismatch {
	readonly message: string;
	readonly errorCode: typeof RPC_ERROR_PROJECT_CWD_MISMATCH | typeof RPC_ERROR_INVALID_ARGUMENT;
}

/**
 * The refusal of a project write whose stated folder is not the session's, or whose `expectedCwd` is present but not a
 * string, or undefined when it may go.
 */
export function projectCwdMismatch(
	command: { readonly type: string; readonly expectedCwd?: unknown },
	sessionCwd: string,
): CwdMismatch | undefined {
	if (!PROJECT_WRITES.has(command.type) || command.expectedCwd === undefined) return undefined;
	if (typeof command.expectedCwd !== "string")
		return {
			message: "expectedCwd must be a string: the folder this write is for; nothing was written.",
			errorCode: RPC_ERROR_INVALID_ARGUMENT,
		};
	if (comparableFolder(command.expectedCwd) === comparableFolder(sessionCwd)) return undefined;
	return {
		message: "This session is in another folder than the one this write is for; nothing was written.",
		errorCode: RPC_ERROR_PROJECT_CWD_MISMATCH,
	};
}
