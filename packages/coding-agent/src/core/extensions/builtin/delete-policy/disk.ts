import { lstat, readdir, realpath, statfs } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { AUTO_TRASH_SHARE, type DeletePolicy } from "./policy.ts";
import { errnoCode, TrashError } from "./trash-error.ts";

/** Apparent size of a file or tree; symlinks count as themselves and are never followed. */
export async function measureBytes(path: string): Promise<number> {
	const stats = await lstat(path);
	if (!stats.isDirectory()) return stats.size;
	let total = stats.size;
	for (const name of await readdir(path)) total += await measureBytes(join(path, name));
	return total;
}

function contains(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep));
}

/** The target with its parent directories resolved, so `/tmp` vs `/private/tmp` style aliases compare equal. */
async function canonical(path: string): Promise<string> {
	return join(await realpath(dirname(path)), basename(path));
}

async function canonicalExisting(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error) {
		if (errnoCode(error) === "ENOENT") return path;
		throw error;
	}
}

/**
 * Refuses what a trash move must never take: a missing path, a filesystem root or mount point (renaming
 * it would fail or detach a volume), and the trash itself or anything containing it.
 */
export async function assertTrashable(target: string, trashRoots: readonly string[]): Promise<void> {
	let stats: Awaited<ReturnType<typeof lstat>>;
	try {
		stats = await lstat(target);
	} catch (error) {
		if (errnoCode(error) === "ENOENT") throw new TrashError("not_found", `${target} does not exist.`);
		throw error;
	}
	const parent = dirname(target);
	if (parent === target || (await lstat(parent)).dev !== stats.dev) {
		throw new TrashError("mount_point", `${target} is a mount point or filesystem root; refusing to move it.`);
	}
	const resolved = await canonical(target);
	for (const root of trashRoots) {
		const trash = await canonicalExisting(root);
		if (contains(trash, resolved) || contains(resolved, trash)) {
			throw new TrashError("inside_trash", `${target} is or contains the trash (${root}); refusing to move it.`);
		}
	}
}

/** The top directory of the mount that holds `path`: the highest ancestor still on the same device. */
export async function mountTop(path: string): Promise<string> {
	const device = (await lstat(path)).dev;
	let current = path;
	for (;;) {
		const parent = dirname(current);
		if (parent === current || (await lstat(parent)).dev !== device) return current;
		current = parent;
	}
}

export async function trashCapBytes(policy: DeletePolicy, trashDir: string): Promise<number> {
	if (policy.maxTrashBytes !== "auto") return policy.maxTrashBytes;
	const volume = await statfs(trashDir);
	return Math.floor(volume.blocks * volume.bsize * AUTO_TRASH_SHARE);
}
