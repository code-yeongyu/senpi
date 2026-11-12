/**
 * Proof that a native SQLite open, which reopens a file by name, opened the file a caller validated through its own
 * descriptor (sisyphuslabs/omo-desktop-app#4199). Between that validation and SQLite's open the name can be swapped for
 * another file, and on Windows the validating open cannot refuse a link (there is no O_NOFOLLOW).
 *
 * Every filesystem call here is asynchronous: the socket secret's lock reaches this module from the RPC session path,
 * where no synchronous call may run (`test/suite/no-sync-in-session-path.test.ts`). Only the SQLite open itself is
 * synchronous, and it runs between the two descriptor listings without yielding.
 */
import { type BigIntStats, fstat } from "node:fs";
import { lstat, readdir } from "node:fs/promises";

/** A file's identity: device and inode on POSIX, volume serial number and file index on Windows. */
export interface FileIdentity {
	readonly dev: bigint;
	readonly ino: bigint;
}

export type CheckedOpen<T> = { readonly opened: T } | { readonly replaced: string };

/** One open descriptor of this process that names a regular file. */
interface OpenFile extends FileIdentity {
	readonly fd: number;
}

/** Where this process lists its open descriptors. Elsewhere SQLite's handle is not reachable from JavaScript. */
const DESCRIPTOR_DIRECTORY: Partial<Record<NodeJS.Platform, string>> = { linux: "/proc/self/fd", darwin: "/dev/fd" };

/**
 * Runs `open`, a synchronous SQLite open of `path`, and checks the file it opened is `expected`; on a mismatch it closes
 * what was opened and answers `replaced`.
 *
 * - Linux and macOS: the regular files open before and after `open` are listed, each by descriptor and identity, so a
 *   descriptor number reused for another file still counts as added. SQLite's own descriptor is among the added ones,
 *   and a name swapped for the open and swapped back afterwards is caught when no added descriptor is `expected`.
 *   The listings yield, so other work in this process can open files meanwhile; an added descriptor is therefore
 *   SQLite's only when nothing else explains it. SQLite can reuse a descriptor it parked for the same inode, adding
 *   none of its own: when `expected` was already open before, no added descriptor proves anything, and only the name
 *   check below runs.
 * - Everywhere: `path` itself must be a regular file (not a link) with `expected`'s identity. On Windows this is the
 *   check of SQLite's handle: SQLite opens without FILE_SHARE_DELETE, so the file it holds cannot be renamed away from
 *   or deleted under that name while it is open.
 */
export async function openExpectedFile<T>(
	path: string,
	expected: FileIdentity,
	open: () => T,
	close: (opened: T) => void,
): Promise<CheckedOpen<T>> {
	const before = await openFiles();
	const opened = open();
	const replaced =
		descriptorReplacement(path, expected, before, before && (await openFiles())) ??
		(await nameReplacement(path, expected));
	if (replaced === undefined) return { opened };
	close(opened);
	return { replaced };
}

function descriptorReplacement(
	path: string,
	expected: FileIdentity,
	before: readonly OpenFile[] | undefined,
	after: readonly OpenFile[] | undefined,
): string | undefined {
	if (before === undefined || after === undefined) return undefined;
	// A descriptor of `expected` open before: SQLite may have reused it (see above), so the listing proves nothing.
	if (before.some((file) => sameFile(file, expected))) return undefined;
	const known = new Set(before.map(descriptorKey));
	const added = after.filter((file) => !known.has(descriptorKey(file)));
	if (added.length === 0 || added.some((file) => sameFile(file, expected))) return undefined;
	return `SQLite opened another file than the one validated: ${path}`;
}

async function nameReplacement(path: string, expected: FileIdentity): Promise<string | undefined> {
	let entry: BigIntStats;
	try {
		entry = await lstat(path, { bigint: true });
	} catch (error: unknown) {
		return `cannot inspect ${path} after SQLite opened it: ${(error as Error).message}`;
	}
	if (!entry.isFile() || !sameFile(entry, expected)) return `replaced while SQLite opened it: ${path}`;
	return undefined;
}

async function openFiles(): Promise<OpenFile[] | undefined> {
	const directory = DESCRIPTOR_DIRECTORY[process.platform];
	if (directory === undefined) return undefined;
	let names: string[];
	try {
		names = await readdir(directory);
	} catch {
		// No listable descriptor table (a sandbox without /proc): the name check still runs.
		return undefined;
	}
	// The listing's own directory descriptor is closed again by now, so it fails fstat (or names another file) and
	// drops out or counts as one more open file.
	const fds = names.map(Number).filter((fd) => Number.isInteger(fd));
	const files = await Promise.all(fds.map(regularFile));
	return files.filter((file) => file !== undefined);
}

function regularFile(fd: number): Promise<OpenFile | undefined> {
	return new Promise((resolve) => {
		fstat(fd, { bigint: true }, (error, info) => {
			// An error: closed again since the listing.
			resolve(error === null && info.isFile() ? { fd, dev: info.dev, ino: info.ino } : undefined);
		});
	});
}

function descriptorKey(file: OpenFile): string {
	return `${file.fd}:${file.dev}:${file.ino}`;
}

function sameFile(a: FileIdentity, b: FileIdentity): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}
