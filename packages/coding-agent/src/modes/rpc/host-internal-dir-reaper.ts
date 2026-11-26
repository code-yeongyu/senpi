/**
 * Opportunistic GC of leftover `senpi-rpc-host-internal-*` directories: in the endpoint daemon directories a caller
 * names (where hops live since senpi#7452), in the tmpdir and in the `/tmp` fallback root (senpi#3487).
 * Safe without any lock: a directory is removed only when it belongs to this user, is older than 60 s,
 * holds nothing but its `.owner` record, is owned by a provably dead process, and no listening socket is still bound
 * inside it. The last check matters when a hop's socket NAME was unlinked while its host keeps serving: the
 * directory then looks empty and ownerless, yet it is the only route to a live host (senpi#7452). The ownership check
 * matters in the shared `/tmp` root, where other users' hops live too.
 */
import { lstat, readdir, readFile, readlink, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ProcessIdentityUnreadableError, processMatchesPidFile } from "../../utils/process-identity.ts";
import { INTERNAL_HOST_DIR_PREFIX, internalHostDirRoots } from "./host-lifecycle-scratch.ts";
import { ALIAS_LINK, ALIAS_PREFIX } from "./host-socket-bind.ts";

export async function reapOrphanedInternalHostDirs(hostDirs: readonly string[] = []): Promise<void> {
	const served = await listeningUnixSocketPaths();
	await Promise.all(
		[...hostDirs, ...internalHostDirRoots()].map((root) => reapOrphanedInternalHostDirsIn(root, served)),
	);
}

/**
 * Linux lists every bound unix socket in /proc/net/unix by the path it was bound at, and keeps that path after the
 * name is unlinked. Columns: Num RefCount Protocol Flags Type St Inode Path; flag 0x10000 (__SO_ACCEPTCON) marks a
 * listener. Elsewhere nothing equivalent is cheap to read, and a served hop there keeps its socket entry.
 * A hop too deep for a direct bind is bound through a `senpi-bind-*` alias (host-socket-bind.ts), whose link names
 * the hop's bind directory even after that directory is gone, so such a path is read back through the link.
 */
async function listeningUnixSocketPaths(): Promise<readonly string[]> {
	if (process.platform !== "linux") return [];
	let table: string;
	try {
		table = await readFile("/proc/net/unix", "utf8");
	} catch {
		return [];
	}
	const bound = table
		.split("\n")
		.slice(1)
		.flatMap((line) => {
			const fields = line.trim().split(/\s+/);
			if (fields.length < 8 || (Number.parseInt(fields[3] ?? "0", 16) & 0x10000) === 0) return [];
			return [fields.slice(7).join(" ")];
		});
	return Promise.all(bound.map(throughBindAlias));
}

async function throughBindAlias(path: string): Promise<string> {
	const link = dirname(path);
	if (basename(link) !== ALIAS_LINK || !basename(dirname(link)).startsWith(ALIAS_PREFIX)) return path;
	return readlink(link).then(
		(target) => join(target, basename(path)),
		() => path,
	);
}

async function reapOrphanedInternalHostDirsIn(root: string, served: readonly string[]): Promise<void> {
	try {
		const entries = await readdir(root, { withFileTypes: true });
		await Promise.all(
			entries
				.filter((entry) => entry.isDirectory() && entry.name.startsWith(INTERNAL_HOST_DIR_PREFIX))
				.map(async (entry) => {
					try {
						const dir = join(root, entry.name);
						const uid = process.getuid?.();
						if (uid !== undefined && (await lstat(dir)).uid !== uid) return;
						if (served.some((path) => path.startsWith(`${dir}/`))) return;
						const owner = JSON.parse(await readFile(join(dir, ".owner"), "utf8")) as {
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
							(await readdir(dir)).length === 1 &&
							!(await processMatchesPidFile({ pid: owner.pid, processStartTime: owner.processStartTime }).catch(
								(error: unknown) => {
									// Unreadable but live: assume the owner is alive rather than steal its lock.
									if (error instanceof ProcessIdentityUnreadableError) return true;
									throw error;
								},
							))
						)
							await rm(dir, { recursive: true, force: true });
					} catch {}
				}),
		);
	} catch {}
}
