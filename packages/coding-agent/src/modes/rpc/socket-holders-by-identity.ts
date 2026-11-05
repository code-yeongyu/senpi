/**
 * The processes holding a unix socket, found by the socket's inode instead of its name (#5319).
 *
 * `lsof` reports a unix socket under the path it was BOUND at, and it matches a path argument by that
 * name only. A host publishes its endpoint with `link(2)` from a private `<endpoint>.bind-*` directory,
 * or through a short alias, so `lsof -- <endpoint>` finds no holder while the listener is live. This
 * scan lists every process's unix sockets and keeps the names that resolve to the entry's dev:ino.
 *
 * `undefined` means "could not be read", which every caller treats as "a holder may be there". Matching
 * only ever adds pids, so the worst case is reading a dead entry as live and leaving it in place.
 */
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";

const SCAN_TIMEOUT_MS = 5_000;

export async function socketHoldersByIdentity(identity: {
	readonly dev: number;
	readonly ino: number;
}): Promise<readonly number[] | undefined> {
	const listing = await new Promise<string | undefined>((resolve) => {
		execFile(
			"lsof",
			["-U", "-w", "-F", "pn"],
			{ timeout: SCAN_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
			(error, out) => {
				// lsof exits 1 when some process could not be read; the listing it did print is still evidence.
				const code: unknown = error === null ? undefined : Reflect.get(error, "code");
				resolve(error === null || code === 1 ? String(out) : undefined);
			},
		);
	});
	if (listing === undefined) return undefined;
	const pids = new Set<number>();
	const sameInode = new Map<string, boolean>();
	let pid: number | undefined;
	for (const line of listing.split("\n")) {
		if (line.startsWith("p")) pid = Number(line.slice(1));
		if (!line.startsWith("n/") || pid === undefined || !Number.isInteger(pid)) continue;
		// Linux lsof appends the socket type to the bound path: `n/run/x/s type=STREAM`.
		const name = line.slice(1).replace(/ type=\S+.*$/, "");
		let same = sameInode.get(name);
		if (same === undefined) {
			const entry = await stat(name).catch(() => undefined);
			same = entry !== undefined && entry.dev === identity.dev && entry.ino === identity.ino;
			sameInode.set(name, same);
		}
		if (same) pids.add(pid);
	}
	return [...pids];
}
