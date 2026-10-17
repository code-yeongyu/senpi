/**
 * The supervisor's own SCRATCH state: the private internal-hop directory, the record of its host child's
 * identity, and the boot settings it reads. Split out of `host-lifecycle-launch.ts` (senpi#2566).
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProcessIdentity, readProcessStartTime } from "../../utils/process-identity.ts";
import { writeJsonAtomic } from "./host-state-json.ts";
import { errorMessage, supervisorLog } from "./host-supervisor-log.ts";
import { MAX_SOCKET_PATH_BYTES } from "./socket-ownership.ts";

export const INTERNAL_HOST_DIR_PREFIX = "senpi-rpc-host-internal-";
const SHORT_TEMP_ROOT = "/tmp";

/**
 * Where the internal hop directories may live: the OS temp directory first, then `/tmp` for a
 * temp directory too deep for sun_path (a nested per-user or per-job TMPDIR, senpi#3487). The
 * reaper scans the same roots, so a hop placed in the fallback is still collected.
 */
export function internalHostDirRoots(): readonly string[] {
	const primary = tmpdir();
	return primary === SHORT_TEMP_ROOT ? [primary] : [primary, SHORT_TEMP_ROOT];
}

function internalHostDirRoot(name: string): string {
	for (const root of internalHostDirRoots()) {
		if (Buffer.byteLength(join(root, name, "host.sock")) <= MAX_SOCKET_PATH_BYTES) return root;
	}
	throw new Error(
		`internal_socket_path_too_long: ${join(tmpdir(), name, "host.sock")} exceeds ${MAX_SOCKET_PATH_BYTES} bytes and /tmp cannot hold it either; set TMPDIR to a shorter directory`,
	);
}

/**
 * The internal hop must stay short enough for sun_path (104 bytes on macOS)
 * regardless of where the public socket lives, and private against other local
 * users, so it gets its own 0700 directory under the OS temp directory, or under
 * `/tmp` when the temp directory itself is too deep (senpi#3487).
 *
 * On win32 the directory lives under the caller-supplied rpc-host-daemon
 * directory, which ensureHost() creates but a direct --internal-rpc-host-supervisor
 * launch does not, so the parent is created recursively.
 */
export async function createInternalSocketPath(
	baseDir = tmpdir(),
	platform: NodeJS.Platform = process.platform,
): Promise<{ socket: string; dir?: string; secretPath?: string }> {
	if (platform === "win32") {
		const dir = join(baseDir, `internal-${randomUUID()}`);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		return {
			socket: `\\\\.\\pipe\\senpi-rpc-internal-${randomUUID()}`,
			dir,
			secretPath: join(dir, "secret"),
		};
	}
	const name = `${INTERNAL_HOST_DIR_PREFIX}${randomUUID().slice(0, 8)}`;
	// Non-recursive and 0700: a fresh, unguessable directory of this user's, never an existing one.
	const dir = join(internalHostDirRoot(name), name);
	await mkdir(dir, { recursive: false, mode: 0o700 });
	await writeFile(
		join(dir, ".owner"),
		JSON.stringify({
			pid: process.pid,
			processStartTime: await readProcessStartTime(process.pid),
			createdAt: Date.now(),
		}),
		{ mode: 0o600 },
	);
	return { socket: join(dir, "host.sock"), dir, secretPath: join(dir, ".secret") };
}

/** Best-effort, 0600, by rename; released with the generation directory. */
export async function recordChildPid(file: string, pid: number): Promise<void> {
	try {
		const identity = await readProcessIdentity(pid, process.platform, 1_000, undefined, "UTC");
		const processStartTime = identity.kind === "present" ? identity.identity : null;
		if (processStartTime === null) supervisorLog(`host child pid ${pid} start time unreadable at recording`);
		await writeJsonAtomic(file, { pid, processStartTime });
	} catch (cause) {
		supervisorLog(`could not record the host child pid: ${errorMessage(cause)}`);
	}
}

export async function readSettingsFile(settingsFile: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(settingsFile, "utf8"));
	} catch {
		return undefined;
	}
}
