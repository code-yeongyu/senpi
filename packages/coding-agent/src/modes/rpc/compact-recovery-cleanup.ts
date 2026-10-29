import { lstat, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { privateRootStat, readRootMarker, rootOwnerState } from "./compact-root-owner.ts";

interface UnknownRoot {
	readonly name: string;
	readonly ageMs: number;
	readonly bytes: number | null;
	readonly reason: string;
}
export interface RootSweep {
	readonly removed: number;
	readonly unknown: readonly UnknownRoot[];
	readonly failures: readonly { readonly name: string; readonly operation: "reclaim"; readonly cause: string }[];
	readonly skipped?: "windows_owner_and_nofollow_unavailable";
}
const ROOT_NAME = /^senpi-(?:transcript|settled|current|event-leases)-/;

/** No-follow size accounting: a symlink's entry is counted, never its target. */
async function rootBytes(path: string): Promise<number | null> {
	try {
		const stat = await lstat(path);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return stat.size;
		let bytes = 0;
		for (const name of await readdir(path)) {
			const child = await rootBytes(join(path, name));
			if (child === null) return null;
			bytes += child;
		}
		return bytes;
	} catch (cause) {
		if (cause instanceof Error) return null;
		throw cause;
	}
}

/**
 * RULING-65/79: only direct producer children of this base, and only scratch whose owner is proven dead.
 * Engine accepted state is ephemeral scratch, not desktop SQL/replay commitment. Windows is a no-op because
 * this sweep cannot prove POSIX ownership or no-follow traversal there; ordinary store retirement is unchanged.
 */
export async function sweepRecoveryRoots(base: string): Promise<RootSweep> {
	if (process.platform === "win32")
		return { removed: 0, unknown: [], failures: [], skipped: "windows_owner_and_nofollow_unavailable" };
	const ownedBase = resolve(base);
	const unknown: UnknownRoot[] = [];
	const failures: { name: string; operation: "reclaim"; cause: string }[] = [];
	let removed = 0;
	for (const name of await readdir(ownedBase)) {
		if (!ROOT_NAME.test(name)) continue;
		const path = join(ownedBase, name);
		if (dirname(path) !== ownedBase) continue;
		try {
			const stat = await lstat(path);
			const marker = privateRootStat(stat) ? await readRootMarker(path) : undefined;
			const owner = marker ? await rootOwnerState(marker.owner) : "unknown";
			if (marker?.kind === "scratch" && owner === "dead") {
				const current = await lstat(path);
				if (current.dev !== stat.dev || current.ino !== stat.ino || !privateRootStat(current))
					throw new Error("root identity changed during classification");
				await rm(path, { recursive: true });
				removed += 1;
			} else if (!marker || owner === "unknown") {
				unknown.push({
					name,
					ageMs: Math.max(0, Date.now() - stat.mtimeMs),
					bytes: await rootBytes(path),
					reason: "ownership_unknown",
				});
			}
		} catch (cause) {
			if (!(cause instanceof Error)) throw cause;
			if ("code" in cause && cause.code === "ENOENT") continue;
			failures.push({ name, operation: "reclaim", cause: cause.message });
		}
	}
	return { removed, unknown, failures };
}

/** Startup errors stay visible and counted; they never prevent the host from accepting other work. */
export async function startRecoveryCleanup(base: string): Promise<RootSweep> {
	const result = await sweepRecoveryRoots(base).catch((cause: unknown): RootSweep => {
		if (!(cause instanceof Error)) throw cause;
		return { removed: 0, unknown: [], failures: [{ name: ".", operation: "reclaim", cause: cause.message }] };
	});
	if (result.unknown.length || result.failures.length || result.skipped)
		process.stderr.write(`senpi rpc recovery roots: ${JSON.stringify(result)}\n`);
	return result;
}
