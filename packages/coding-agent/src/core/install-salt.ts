import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const SALT_BYTES = 32;
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "ENOSYS"]);
const saltsByPath = new Map<string, Buffer>();

/**
 * Removes a salt file of the wrong length (truncated or written by something else) so the next create
 * replaces it. A file another process has already replaced (a different inode) is kept. The check and
 * the unlink are not one atomic step, so two processes that both start against a damaged file can, in a
 * narrow window, end with different salts until the next restart; salts key digests and routing keys,
 * so that only costs a mismatch, never secrecy.
 */
function removeDamagedSalt(path: string, damagedInode: number): boolean {
	try {
		if (statSync(path).ino !== damagedInode) return true;
		unlinkSync(path);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

function readOrCreateSalt(path: string): Buffer | undefined {
	try {
		const inode = statSync(path).ino;
		const stored = readFileSync(path);
		if (stored.length === SALT_BYTES) return stored;
		if (!removeDamagedSalt(path, inode)) return undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
	}
	// The salt is written whole to a private file and then hard-linked into place: the link either
	// creates the final name with all 32 bytes or fails with EEXIST, so a racing process never reads a
	// half-written salt, and every process converges on the first one linked.
	const staged = `${path}.${process.pid}.${randomBytes(6).toString("hex")}`;
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		const salt = randomBytes(SALT_BYTES);
		writeFileSync(staged, salt, { flag: "wx", mode: 0o600 });
		try {
			linkSync(staged, path);
		} catch (error) {
			// A filesystem without hard links: create the final name directly. A process starting at the same
			// moment can see it half-written and replace it, so concurrent first starts there may diverge until
			// the next restart; later starts converge on the stored salt.
			if (!NO_HARD_LINKS.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
			writeFileSync(path, salt, { flag: "wx", mode: 0o600 });
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") return undefined;
	} finally {
		try {
			unlinkSync(staged);
		} catch {}
	}
	try {
		return readFileSync(path);
	} catch {
		return undefined;
	}
}

/**
 * A random 32-byte salt created once per install at `<agentDir>/<relativePath>` (mode 0600). Its users
 * are diagnostics and routing keys, which must never fail a turn: an unreadable, unwritable or
 * half-written salt file falls back to a salt for this process only, so keyed values stay unguessable
 * and merely stop matching across restarts.
 */
export function installSalt(agentDir: string, relativePath: string): Buffer {
	const path = join(agentDir, relativePath);
	const cached = saltsByPath.get(path);
	if (cached) return cached;
	const stored = readOrCreateSalt(path);
	const salt = stored?.length === SALT_BYTES ? stored : randomBytes(SALT_BYTES);
	saltsByPath.set(path, salt);
	return salt;
}
