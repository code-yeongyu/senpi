import { randomUUID } from "node:crypto";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MoveId } from "./ownership.ts";

/** Staging lives under this folder of the session directory: one folder per move, one per import attempt under it. */
const STAGING_DIR = ".move-staging";

/** A folder an import attempt died in is removed once nothing has written to it for an hour. */
const ABANDONED_ATTEMPT_MS = 60 * 60_000;

/**
 * Where ONE import attempt stages the session it is about to land (senpi#4016). Two imports of one move pass
 * `beginReceive` together, and a folder they shared let the later one remove and re-copy what the earlier one was
 * about to commit; each attempt now assembles its own and commits only what it staged itself.
 */
export function attemptStaging(
	sessionDir: string,
	moveId: MoveId,
): { readonly attempts: string; readonly staging: string } {
	const attempts = join(sessionDir, STAGING_DIR, encodeURIComponent(moveId));
	return { attempts, staging: join(attempts, `${Date.now().toString(36)}-${randomUUID()}`) };
}

/** Removes the folders of attempts that died, by age, so a crash leaves no folder behind for good. */
export async function sweepAbandonedAttempts(attempts: string): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(attempts);
	} catch {
		return;
	}
	const oldest = Date.now() - ABANDONED_ATTEMPT_MS;
	await Promise.all(
		entries.map(async (entry) => {
			const folder = join(attempts, entry);
			const changed = await stat(folder).then(
				(info) => info.mtimeMs,
				() => Number.POSITIVE_INFINITY,
			);
			if (changed < oldest) await rm(folder, { recursive: true, force: true }).catch(() => undefined);
		}),
	);
}
