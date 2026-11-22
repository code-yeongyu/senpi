import { statSync } from "node:fs";
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
		throw sessionCwdStatError(cwd, error);
	}
	if (!isDirectory) throw new CodemodeSessionCwdUnavailableError(cwd, "not a directory");
}

/** Warm reuse checks every cell without a filesystem thread-pool round trip. */
export function assertSessionCwdAvailableSync(cwd: string): void {
	let isDirectory: boolean;
	try {
		isDirectory = statSync(cwd).isDirectory();
	} catch (error) {
		throw sessionCwdStatError(cwd, error);
	}
	if (!isDirectory) throw new CodemodeSessionCwdUnavailableError(cwd, "not a directory");
}

function sessionCwdStatError(cwd: string, error: unknown): unknown {
	if (
		error instanceof Error &&
		"code" in error &&
		typeof error.code === "string" &&
		MISSING_DIRECTORY_CODES.has(error.code)
	) {
		return new CodemodeSessionCwdUnavailableError(cwd, error.code);
	}
	return error;
}
