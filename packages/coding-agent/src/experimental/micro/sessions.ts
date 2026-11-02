import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { getAgentDir } from "../../config.ts";
import { type HeldFileLock, lockWithLossHandling } from "../../core/file-lock.ts";

export interface MicroSessionLocation {
	id: string;
	path: string;
	cwd: string;
	created: boolean;
	release(): Promise<void>;
	/** Throws FileLockLostError once another process reclaimed the session lock. */
	assertHeld(): void;
}

function cwdKey(cwd: string): string {
	return createHash("sha256").update(cwd).digest("hex").slice(0, 24);
}

/** Select a new session, or the newest session for this cwd, without opening any JSONL logs. */
export async function selectSession(
	cwdInput: string,
	continueSession: boolean,
	onLost: (error: Error) => void,
): Promise<MicroSessionLocation> {
	const cwd = await realpath(resolve(cwdInput));
	const root = join(getAgentDir(), "experimental", "micro-sessions", cwdKey(cwd));
	await mkdir(root, { recursive: true });

	let path: string;
	let created = false;
	if (continueSession) {
		const entries = await readdir(root, { withFileTypes: true });
		const newest = entries
			.filter((entry) => entry.isDirectory() && /^\d{13}-[0-9a-f-]{36}$/u.test(entry.name))
			.map((entry) => entry.name)
			.sort()
			.at(-1);
		if (!newest) throw new Error(`No micro session exists for ${cwd}`);
		path = join(root, newest);
	} else {
		path = join(root, `${String(Date.now()).padStart(13, "0")}-${randomUUID()}`);
		await mkdir(path);
		created = true;
	}

	let lock: HeldFileLock;
	try {
		lock = await lockWithLossHandling(path, { realpath: false, retries: 0, onLost });
	} catch (error) {
		throw new Error(`Micro session is already open: ${path}`, { cause: error });
	}
	return { id: basename(path), path, cwd, created, release: lock.release, assertHeld: lock.assertHeld };
}
