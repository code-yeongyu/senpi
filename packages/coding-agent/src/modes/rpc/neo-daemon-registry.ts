/**
 * Neo daemon registry: the on-disk record clients use to find a running daemon
 * for a given cwd.
 *
 * Layout: `<agentDir>/neo-daemon/<cwd-key>.json`, mode 0600, containing
 * `{ version, socket, pid, token }`. The daemon is the ONLY writer — clients
 * only read. Writes are atomic (temp file + rename) so a client never observes a
 * half-written record.
 *
 * `cwd-key` uses the same safe-path scheme as the session manager
 * (session-manager.ts getDefaultSessionDirPath) so one cwd maps to exactly one
 * daemon record.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { resolvePath } from "../../utils/paths.ts";

/** Bump when the wire protocol or handshake changes incompatibly. */
export const NEO_DAEMON_PROTOCOL_VERSION = 1;

export interface NeoDaemonRecord {
	/** Protocol version the daemon speaks; clients refuse on mismatch. */
	readonly version: number;
	/** Absolute unix socket path (or Windows named-pipe path) the daemon listens on. */
	readonly socket: string;
	/** Daemon process id, used for stale-record detection. */
	readonly pid: number;
	/** Handshake token; a client must present it in `hello`. */
	readonly token: string;
}

/**
 * Compute the safe registry-key for a cwd. Mirrors the session-manager
 * safe-path scheme so both derive the same key from the same cwd.
 */
export function neoDaemonCwdKey(cwd: string): string {
	const resolvedCwd = resolvePath(cwd);
	return `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** Directory holding all neo daemon registry records. */
export function neoDaemonRegistryDir(agentDir: string): string {
	return join(agentDir, "neo-daemon");
}

/** Absolute path to the registry record for a cwd. */
export function neoDaemonRegistryPath(agentDir: string, cwd: string): string {
	return join(neoDaemonRegistryDir(agentDir), `${neoDaemonCwdKey(cwd)}.json`);
}

function isValidRecord(value: unknown): value is NeoDaemonRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.version === "number" &&
		typeof record.socket === "string" &&
		typeof record.pid === "number" &&
		typeof record.token === "string"
	);
}

/**
 * Read the registry record for a cwd. Returns undefined when the file is
 * missing, unreadable, or malformed (all non-fatal — the caller then spawns).
 */
export function readNeoDaemonRecord(agentDir: string, cwd: string): NeoDaemonRecord | undefined {
	const path = neoDaemonRegistryPath(agentDir, cwd);
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	return isValidRecord(parsed) ? parsed : undefined;
}

/**
 * Atomically write the registry record (temp file + rename, mode 0600). The
 * daemon calls this as the LAST listen step, after the socket is bound and
 * listening.
 */
export function writeNeoDaemonRecord(agentDir: string, cwd: string, record: NeoDaemonRecord): void {
	const dir = neoDaemonRegistryDir(agentDir);
	mkdirSync(dir, { recursive: true });
	const finalPath = neoDaemonRegistryPath(agentDir, cwd);
	const tempPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tempPath, JSON.stringify(record, null, 2), { mode: 0o600 });
	renameSync(tempPath, finalPath);
}

/** Remove the registry record for a cwd (best-effort; missing is fine). */
export function removeNeoDaemonRecord(agentDir: string, cwd: string): void {
	const path = neoDaemonRegistryPath(agentDir, cwd);
	try {
		unlinkSync(path);
	} catch {
		// already gone
	}
}

/**
 * Whether a pid is alive. `process.kill(pid, 0)` throws ESRCH for a dead pid and
 * EPERM for a live pid we cannot signal (which still means "alive").
 */
export function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "EPERM";
	}
}

/**
 * Clean up a stale record + its socket file for a cwd BEFORE a fresh daemon
 * binds. A record is stale when its pid is dead. Returns true when something was
 * cleaned. The bound socket path is unlinked so the fresh bind does not hit a
 * leftover socket file.
 */
export function cleanupStaleNeoDaemon(agentDir: string, cwd: string): boolean {
	const record = readNeoDaemonRecord(agentDir, cwd);
	if (!record) {
		// No record: still unlink a dangling socket path if the caller left one.
		return false;
	}
	if (isPidAlive(record.pid)) {
		return false;
	}
	// Stale: remove the socket file and the record.
	if (record.socket && existsSync(record.socket)) {
		try {
			rmSync(record.socket, { force: true });
		} catch {
			// non-fatal
		}
	}
	removeNeoDaemonRecord(agentDir, cwd);
	return true;
}

/**
 * Reclaim a leftover unix-socket file at `listenPath` when NO live daemon is
 * serving it, so a fresh bind() does not hit EADDRINUSE forever.
 *
 * This is the safety net that makes the DETERMINISTIC socket path safe: a daemon
 * SIGKILLed without a clean shutdown leaves the socket file on disk with its
 * registry record gone (so {@link cleanupStaleNeoDaemon}, which keys off the
 * record, misses it). bind() on a leftover unix-socket file throws EADDRINUSE
 * whether or not anyone is listening, so the fresh daemon must probe the path and
 * unlink it when it is dead.
 *
 * A LIVE daemon serving the socket accepts a connection; we must NOT unlink that
 * one — the caller then loses the bind race (EADDRINUSE) and attaches to the
 * winner, which is the intended "bind is the mutex" outcome. We only unlink when
 * connecting is refused/errors (a dead socket) or the path is a plain file.
 *
 * No-op on Windows named pipes (not filesystem paths; the OS reclaims a pipe when
 * its owner dies) and when nothing exists at the path.
 */
export async function reclaimDeadSocketFile(listenPath: string): Promise<void> {
	if (process.platform === "win32") return;
	if (!existsSync(listenPath)) return;
	const alive = await isSocketServed(listenPath);
	if (alive) return; // a live daemon owns it — let the caller lose the bind race
	try {
		rmSync(listenPath, { force: true });
	} catch {
		// non-fatal: bind will surface any real problem as EADDRINUSE/EACCES
	}
}

/** Whether a unix socket at `path` currently accepts a connection (a live server). */
function isSocketServed(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect(path);
		const done = (alive: boolean): void => {
			socket.removeAllListeners();
			socket.destroy();
			resolve(alive);
		};
		socket.once("connect", () => done(true));
		socket.once("error", () => done(false));
	});
}
