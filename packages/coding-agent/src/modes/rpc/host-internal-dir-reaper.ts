/**
 * Opportunistic GC of other installs' leftover `senpi-rpc-host-internal-*` directories in the tmpdir.
 * Safe without any lock: a directory is removed only when older than 60 s, holding nothing but its
 * `.owner` record, and owned by a provably dead process.
 */
import { readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessIdentityUnreadableError, processMatchesPidFile } from "../app-server/daemon/process.ts";

export async function reapOrphanedInternalHostDirs(): Promise<void> {
	try {
		const entries = await readdir(tmpdir(), { withFileTypes: true });
		await Promise.all(
			entries
				.filter((entry) => entry.isDirectory() && entry.name.startsWith("senpi-rpc-host-internal-"))
				.map(async (entry) => {
					try {
						const owner = JSON.parse(await readFile(join(tmpdir(), entry.name, ".owner"), "utf8")) as {
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
							(await readdir(join(tmpdir(), entry.name))).length === 1 &&
							!(await processMatchesPidFile({ pid: owner.pid, processStartTime: owner.processStartTime }).catch(
								(error: unknown) => {
									// Unreadable but live: assume the owner is alive rather than steal its lock.
									if (error instanceof ProcessIdentityUnreadableError) return true;
									throw error;
								},
							))
						)
							await rm(join(tmpdir(), entry.name), { recursive: true, force: true });
					} catch {}
				}),
		);
	} catch {}
}
