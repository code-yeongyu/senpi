/**
 * Proof that a native SQLite open, which reopens a file by name, opened the file a caller validated through its own
 * descriptor (sisyphuslabs/omo-desktop-app#4199). Between that validation and SQLite's open the name can be swapped for
 * another file, and on Windows the validating open cannot refuse a link (there is no O_NOFOLLOW).
 */
import { type BigIntStats, fstatSync, lstatSync, readdirSync } from "node:fs";

/** A file's identity: device and inode on POSIX, volume serial number and file index on Windows. */
export interface FileIdentity {
	readonly dev: bigint;
	readonly ino: bigint;
}

export type CheckedOpen<T> = { readonly opened: T } | { readonly replaced: string };

/** Where this process lists its open descriptors. Elsewhere SQLite's handle is not reachable from JavaScript. */
const DESCRIPTOR_DIRECTORY: Partial<Record<NodeJS.Platform, string>> = { linux: "/proc/self/fd", darwin: "/dev/fd" };

/**
 * Runs `open`, a synchronous SQLite open of `path`, and checks the file it opened is `expected`; on a mismatch it closes
 * what was opened and answers `replaced`.
 *
 * - Linux and macOS: a descriptor added by the open must be `expected`. That is SQLite's own descriptor, so a name swapped
 *   for the open and swapped back afterwards is caught. SQLite can instead reuse a descriptor it parked for the same
 *   inode, adding none; only the name check below runs then.
 * - Everywhere: `path` itself must be a regular file (not a link) with `expected`'s identity. On Windows this is the
 *   check of SQLite's handle: SQLite opens without FILE_SHARE_DELETE, so the file it holds cannot be renamed away from
 *   or deleted under that name while it is open.
 */
export function openExpectedFile<T>(
	path: string,
	expected: FileIdentity,
	open: () => T,
	close: (opened: T) => void,
): CheckedOpen<T> {
	const before = openDescriptors();
	const opened = open();
	const replaced = replacement(path, expected, before, before && openDescriptors());
	if (replaced === undefined) return { opened };
	close(opened);
	return { replaced };
}

function replacement(
	path: string,
	expected: FileIdentity,
	before: ReadonlySet<number> | undefined,
	after: ReadonlySet<number> | undefined,
): string | undefined {
	if (before !== undefined && after !== undefined) {
		const added = [...after].filter((fd) => !before.has(fd)).flatMap((fd) => regularFile(fd) ?? []);
		if (added.length > 0 && !added.some((identity) => sameFile(identity, expected))) {
			return `SQLite opened another file than the one validated: ${path}`;
		}
	}
	let entry: BigIntStats;
	try {
		entry = lstatSync(path, { bigint: true });
	} catch (error: unknown) {
		return `cannot inspect ${path} after SQLite opened it: ${(error as Error).message}`;
	}
	if (!entry.isFile() || !sameFile(entry, expected)) return `replaced while SQLite opened it: ${path}`;
	return undefined;
}

function openDescriptors(): Set<number> | undefined {
	const directory = DESCRIPTOR_DIRECTORY[process.platform];
	if (directory === undefined) return undefined;
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch {
		// No listable descriptor table (a sandbox without /proc): the name check still runs.
		return undefined;
	}
	// The listing's own directory descriptor is closed again by now, so it fails fstat and drops out.
	return new Set(names.map(Number).filter((fd) => Number.isInteger(fd) && isOpen(fd)));
}

function isOpen(fd: number): boolean {
	try {
		fstatSync(fd);
		return true;
	} catch {
		return false;
	}
}

function regularFile(fd: number): FileIdentity | undefined {
	try {
		const info = fstatSync(fd, { bigint: true });
		return info.isFile() ? { dev: info.dev, ino: info.ino } : undefined;
	} catch {
		// Closed again by another thread since the listing; it was not SQLite's.
		return undefined;
	}
}

function sameFile(a: FileIdentity, b: FileIdentity): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}
