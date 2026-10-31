import { createHmac, randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../../../config.ts";

const SALT_FILE = join("anthropic-subscription", "seat-digest-salt");
const SALT_BYTES = 32;
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "ENOSYS"]);
const saltsByAgentDir = new Map<string, Buffer>();

/**
 * Removes a salt file of the wrong length (truncated or written by something else) so the next create
 * replaces it. A file another process has already replaced (a different inode) is kept. The check and
 * the unlink are not one atomic step, so two processes that both start against a damaged file can, in a
 * narrow window, end with different salts until the next restart; digests are diagnostics, so that only
 * costs a mismatch, never secrecy.
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
 * The install's salt. A digest is diagnostics and must never fail a turn: an unreadable, unwritable
 * or half-written salt file falls back to a salt for this process only, so digests stay unguessable
 * and merely stop matching across restarts.
 */
function installSalt(agentDir: string): Buffer {
	const cached = saltsByAgentDir.get(agentDir);
	if (cached) return cached;
	const stored = readOrCreateSalt(join(agentDir, SALT_FILE));
	const salt = stored?.length === SALT_BYTES ? stored : randomBytes(SALT_BYTES);
	saltsByAgentDir.set(agentDir, salt);
	return salt;
}

/**
 * An 8-hex digest of an account slot name keyed by a random per-install salt, so logs and
 * diagnostics can tell seats apart without naming them, and a guessed slot name ("env", an email
 * address) cannot be confirmed without this install's salt (oh-my-openagent#10304).
 */
export function seatDigest(accountName: string, agentDir: string = getAgentDir()): string {
	return createHmac("sha256", installSalt(agentDir)).update(accountName).digest("hex").slice(0, 8);
}
