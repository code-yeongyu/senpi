import { stat } from "node:fs/promises";

// Only these codes mean the directory is gone or was never one; anything else (EACCES, ELOOP,
// EMFILE, EIO, ...) is a real failure that reopening the session would not fix, so it surfaces as is.
const MISSING_DIRECTORY_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);

export class CodemodeSessionCwdUnavailableError extends Error {
	readonly name = "CodemodeSessionCwdUnavailableError";
	readonly cwd: string;

	constructor(cwd: string, reason: string) {
		super(
			`The session working directory ${cwd} is unavailable (${reason}). Eval cells run in the session's project directory; reopen the session on an existing directory.`,
		);
		this.cwd = cwd;
	}
}

export async function assertSessionCwdAvailable(cwd: string): Promise<void> {
	let isDirectory: boolean;
	try {
		isDirectory = (await stat(cwd)).isDirectory();
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			typeof error.code === "string" &&
			MISSING_DIRECTORY_CODES.has(error.code)
		) {
			throw new CodemodeSessionCwdUnavailableError(cwd, error.code);
		}
		throw error;
	}
	if (!isDirectory) throw new CodemodeSessionCwdUnavailableError(cwd, "not a directory");
}
