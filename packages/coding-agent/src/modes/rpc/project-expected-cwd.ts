/**
 * A project write may state the folder its caller means (`expectedCwd`). A client that reaches a session by a key that
 * can since name another session (a remote desktop, through a relay) states it, so the write lands only in the project
 * it means: when the session's working directory is another folder, the write is refused and nothing is written.
 * Absent, the write goes as it always has.
 */
import { RPC_ERROR_PROJECT_CWD_MISMATCH } from "./rpc-error-types.ts";

/** The project writes that may state the folder they mean. */
const PROJECT_WRITES: ReadonlySet<string> = new Set(["set_project_trust", "set_project_setting", "write_project_file"]);

/** A folder path for comparison: surrounding whitespace and trailing separators dropped; a bare root stays itself. */
export function comparableFolder(path: string): string {
	const trimmed = path.trim();
	const stripped = trimmed.replace(/[/\\]+$/u, "");
	return stripped.length === 0 ? trimmed.slice(0, 1) : stripped;
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
