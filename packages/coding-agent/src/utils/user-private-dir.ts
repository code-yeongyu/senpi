/**
 * A directory of THIS user for state that would otherwise sit at a fixed name under the shared temp root (senpi#6871).
 *
 * On Linux `tmpdir()` is `/tmp` for every user, so a fixed `<tmpdir>/<name>` is one directory for the whole machine:
 * whoever creates it first owns it (0755 after the usual umask), every other user then fails with `EACCES`, and the
 * owner's files sit where anyone can list them. Each user now gets `<tmpdir>/<name>-<uid>`, created 0700; on win32,
 * which has no uid and whose temp directory is already the user's own, `<tmpdir>/<name>` as before.
 *
 * The directory depends on the uid and `tmpdir()` only, never on session environment such as `XDG_RUNTIME_DIR`: a
 * login shell has that variable while cron, `sudo -u`, `docker exec` and detached jobs often do not, and it goes away
 * at logout, so two processes of one user (or one long-lived host before and after a logout) would otherwise resolve
 * two different directories, which for a lock means two holders of one exclusive lock (review M1).
 *
 * The per-uid name is predictable, so another user can create it first or plant a symlink there. An existing
 * directory is therefore opened without following a symlink and checked through that handle: a symlink, a
 * non-directory or another uid's directory is refused (`user_dir_unsafe`). So is one of this user's that group or
 * others could WRITE into: entries planted while it was writable (a symlink named like a file opened later) would
 * survive a chmod (review L3). One they could only read or traverse holds nothing of theirs and is tightened to 0700.
 */
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;

/** Where `name` lives for this user. Path only: `ensurePrivateDirectory` creates and proves it. */
export function userPrivateDirectoryPath(name: string): string {
	const uid = process.getuid?.();
	return process.platform === "win32" || uid === undefined ? join(tmpdir(), name) : join(tmpdir(), `${name}-${uid}`);
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
		if ((entry.mode & 0o022) !== 0) throw unsafe("writable by group or others; remove it and retry");
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
