/**
 * Opportunistic GC of other installs' leftover `senpi-rpc-host-internal-*` directories in the tmpdir
 * and in the `/tmp` fallback root (senpi#3487).
 * Safe without any lock: a directory is removed only when it belongs to this user, is older than 60 s,
 * holds nothing but its `.owner` record, and is owned by a provably dead process. The ownership check
 * matters in the shared `/tmp` root, where other users' hops live too.
 */
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ProcessIdentityUnreadableError, processMatchesPidFile } from "../../utils/process-identity.ts";
import { INTERNAL_HOST_DIR_PREFIX, internalHostDirRoots } from "./host-lifecycle-scratch.ts";

export async function reapOrphanedInternalHostDirs(): Promise<void> {
	await Promise.all(internalHostDirRoots().map((root) => reapOrphanedInternalHostDirsIn(root)));
}

async function reapOrphanedInternalHostDirsIn(root: string): Promise<void> {
	try {
		const entries = await readdir(root, { withFileTypes: true });
		await Promise.all(
			entries
				.filter((entry) => entry.isDirectory() && entry.name.startsWith(INTERNAL_HOST_DIR_PREFIX))
				.map(async (entry) => {
					try {
						const uid = process.getuid?.();
						if (uid !== undefined && (await lstat(join(root, entry.name))).uid !== uid) return;
						const owner = JSON.parse(await readFile(join(root, entry.name, ".owner"), "utf8")) as {
							pid?: unknown;
							processStartTime?: unknown;
							createdAt?: unknown;
						};
						if (
							typeof owner.pid === "number" &&
							typeof owner.processStartTime === "string" &&
							typeof owner.createdAt === "number" &&
							owner.processStartTime.length > 0 &&
							owner.createdAt < Date.now() - 60_000 &&
							(await readdir(join(root, entry.name))).length === 1 &&
							!(await processMatchesPidFile({ pid: owner.pid, processStartTime: owner.processStartTime }).catch(
								(error: unknown) => {
									// Unreadable but live: assume the owner is alive rather than steal its lock.
									if (error instanceof ProcessIdentityUnreadableError) return true;
									throw error;
								},
							))
						)
							await rm(join(root, entry.name), { recursive: true, force: true });
					} catch {}
				}),
		);
	} catch {}
}
