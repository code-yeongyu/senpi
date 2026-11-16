/**
 * A directory of THIS user for state that would otherwise sit at a fixed name under the shared temp root (senpi#6871).
 *
 * On Linux `tmpdir()` is `/tmp` for every user, so a fixed `<tmpdir>/<name>` is one directory for the whole machine:
 * whoever creates it first owns it (0755 after the usual umask), every other user then fails with `EACCES`, and the
 * owner's files sit where anyone can list them. Each user now gets its own:
 *
 * - `$XDG_RUNTIME_DIR/<name>` when that runtime directory is a private directory of this user (absolute, owned by
 *   this uid, no group or other access, as the XDG spec defines it);
 * - otherwise `<tmpdir>/<name>-<uid>`, created 0700;
 * - on win32, which has no uid and whose temp directory is already the user's own, `<tmpdir>/<name>` as before.
 *
 * The per-uid name is predictable, so another user can create it first or plant a symlink there. An existing
 * directory is therefore opened without following a symlink and checked through that handle: a symlink, a
 * non-directory or another uid's directory is refused (`user_dir_unsafe`) and nothing is written through it, and one
 * this user owns but left reachable by group or others is tightened to 0700 through the same handle.
 */
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;

/** Where `name` lives for this user. Path only: `ensurePrivateDirectory` creates and proves it. */
export function userPrivateDirectoryPath(name: string): string {
	const uid = process.getuid?.();
	if (process.platform === "win32" || uid === undefined) return join(tmpdir(), name);
	const runtime = process.env.XDG_RUNTIME_DIR;
	if (runtime !== undefined && isPrivateRuntimeDirectory(runtime, uid)) return join(runtime, name);
	return join(tmpdir(), `${name}-${uid}`);
}

function isPrivateRuntimeDirectory(path: string, uid: number): boolean {
	if (!isAbsolute(path)) return false;
	try {
		const entry = statSync(path);
		return entry.isDirectory() && entry.uid === uid && (entry.mode & 0o077) === 0;
	} catch {
		// Missing or unreadable: not usable, so the per-uid temp directory is used instead.
		return false;
	}
}

/** Creates `directory` (0700), or proves an existing one is a private directory of this user; throws when not. */
export function ensurePrivateDirectory(directory: string): void {
	mkdirSync(dirname(directory), { recursive: true });
	try {
		mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
	} catch (cause) {
		if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
	}
	if (process.platform === "win32") return;
	const unsafe = (reason: string, cause?: unknown) =>
		new Error(`user_dir_unsafe: ${directory} is not a private directory of this user (${reason})`, { cause });
	let fd: number;
	try {
		fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
	} catch (cause) {
		throw unsafe("a symlink, not a directory, or not openable by this user", cause);
	}
	try {
		const entry = fstatSync(fd);
		if (entry.uid !== process.getuid?.()) throw unsafe(`owned by uid ${entry.uid}`);
		if ((entry.mode & 0o077) !== 0) fchmodSync(fd, PRIVATE_DIRECTORY_MODE);
	} finally {
		closeSync(fd);
	}
}

/** This user's directory for `name`, created or proven private; returns its path. */
export function makeUserPrivateDirectory(name: string): string {
	const directory = userPrivateDirectoryPath(name);
	ensurePrivateDirectory(directory);
	return directory;
}
