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

/** What a checked open found that is not a proof. */
type Refusal =
	/** SQLite holds another file than `expected`, or cannot hold it at all. */
	| { readonly replaced: string }
	/**
	 * The listing cannot tell which descriptor is SQLite's. Retryable, like contention: the caller opens again after a
	 * wait and refuses at its deadline, so a persistent attacker is refused and a false alarm clears.
	 */
	| { readonly busy: string };

export type CheckedOpen<T> = { readonly opened: T } | Refusal;

/** One open descriptor of this process that names a regular file. */
interface OpenFile extends FileIdentity {
	readonly fd: number;
}

/** Where this process lists its open descriptors. Elsewhere SQLite's handle is not reachable from JavaScript. */
const DESCRIPTOR_DIRECTORY: Partial<Record<NodeJS.Platform, string>> = { linux: "/proc/self/fd", darwin: "/dev/fd" };

/**
 * The checked opens of this process, one at a time, each with its caller's validation open: a contender's own open of
 * `expected` inside another's listing window would otherwise count as that one's added descriptor and hide its impostor.
 * Each link settles either way, so one failed open never stalls the next, and none waits on a file: `validate` must not
 * block (the callers open a file only to create it, `O_EXCL | O_NONBLOCK`, and `lstat` an existing one), and the
 * listings and the SQLite open do not wait on the file either.
 */
let checkedOpens: Promise<unknown> = Promise.resolve();

/**
 * Runs `validate`, the caller's check of `path` that returns the identity it found and throws to refuse the file, then
 * `open`, a synchronous SQLite open of `path`, and checks the file SQLite opened is that identity (`expected` below).
 * `validate` never opens an existing file: closing that descriptor would drop this process's SQLite locks on it
 * (senpi#6478). Both run inside the one-at-a-time section (`checkedOpens`), so no validation open of a
 * checked file can land in another checked open's listing window. Unless the identity is proven, it closes what was
 * opened and answers `replaced`, or `busy` when only a later open can tell.
 *
 * - Linux and macOS: the regular files open before and after `open` are listed, each by descriptor and identity, so a
 *   descriptor number reused for another file still counts as added. `descriptorRefusal` decides from the two listings.
 *   This is the check that catches a name swapped for the open and swapped back afterwards, which the name check
 *   below cannot see.
 * - Everywhere: `path` itself must be a regular file (not a link) with `expected`'s identity. On Windows this is the
 *   check of SQLite's handle: SQLite opens without FILE_SHARE_DELETE, so the file it holds cannot be renamed away from
 *   or deleted under that name while it is open.
 */
export function openExpectedFile<T>(
	path: string,
	validate: () => Promise<FileIdentity>,
	open: () => T,
	close: (opened: T) => void,
): Promise<CheckedOpen<T>> {
	const run = checkedOpens.then(() => checkedOpen(path, validate, open, close));
	checkedOpens = run.catch(() => undefined);
	return run;
}

async function checkedOpen<T>(
	path: string,
	validate: () => Promise<FileIdentity>,
	open: () => T,
	close: (opened: T) => void,
): Promise<CheckedOpen<T>> {
	const expected = await validate();
	const before = await openFiles();
	const opened = open();
	const after = before && (await openFiles());
	const refusal = before
		? after
			? descriptorRefusal(path, expected, before, after)
			: // The table was listable before the open: without the second listing the proof is missing, never skipped.
				{ busy: `the descriptor listing after SQLite's open of ${path} failed` }
		: undefined;
	const checked = refusal ?? (await nameRefusal(path, expected));
	if (checked === undefined) return { opened };
	close(opened);
	return checked;
}

/**
 * Which file SQLite's open holds, from the regular files open before (`before`) and after it (`after`).
 *
 * How SQLite's unix VFS gets its descriptor (`unixOpen`): `findReusableFd` stats `path` and reuses a descriptor parked on
 * that inode, if any; otherwise it opens `path` anew. A descriptor is parked only when a connection closes while this
 * process still holds POSIX locks on the inode (`unixClose`), and every parked one is closed once those locks are gone
 * (`closePendingFds`). So SQLite holds either a NEW descriptor, which is in `added`, or a REUSED one of the inode `path`
 * named, which was open before. A swap makes both name the impostor, and SQLite parks none for a file it never locked,
 * so a swap shows as an added descriptor that is not `expected`.
 *
 * Other work in this process can still open files during the listings (checked opens and their callers' validation
 * opens are serialized, other opens are not): an added descriptor is not necessarily SQLite's. With E = some added
 * descriptor is `expected`, U = some added regular file is not, B = `expected` was already open before:
 * - E and not U: proven. A new SQLite descriptor is `expected`, since every added one is. A reused one is a parked
 *   descriptor of the inode `path` named, and then the added `expected` descriptor is some other open of `expected`.
 *   Every open of a checked file in this package is either SQLite's or its caller's `validate` (which opens only a file
 *   it creates), and both run only inside the one-at-a-time section, so no such other open can fall in the window. What remains is call discipline: code that
 *   opened `expected` outside `openExpectedFile`, while an attacker linked in a file this process holds SQLite locks on
 *   for exactly that window, would make an impostor pass here.
 * - U, not E, not B: replaced. Nothing of `expected` was open, so SQLite could reuse none of it; its descriptor is new,
 *   among the added ones, and none of them is `expected`.
 * - U, not E, with B (the already-open case): busy. Either SQLite opened an impostor (the swap) or it reused a parked
 *   descriptor of `expected` while this process opened an unrelated file. The listing cannot tell them apart, so it is
 *   never accepted; a retry after the caller's wait proves the open or meets the attacker again.
 * - E and U: busy. The `expected` descriptor may be another open of this process and the other file SQLite's.
 * - neither, with B: busy. SQLite reused a parked descriptor, which happens only while this process holds locks on that
 *   inode (an in-process lock contender, whose lock attempt is busy anyway); once they are released the parked
 *   descriptors are closed, and the next open adds a new descriptor that the listing proves or refuses.
 * - neither, without B: replaced. SQLite added no descriptor and none of `expected` was open, so it cannot hold it.
 *
 * The name check alone therefore never decides when `expected` was already open, nor once the table was listable before
 * the open: every such open is proven by an added descriptor, or retried.
 */
function descriptorRefusal(
	path: string,
	expected: FileIdentity,
	before: readonly OpenFile[],
	after: readonly OpenFile[],
): Refusal | undefined {
	const known = new Set(before.map(descriptorKey));
	const added = after.filter((file) => !known.has(descriptorKey(file)));
	const addedExpected = added.some((file) => sameFile(file, expected));
	const addedOther = added.some((file) => !sameFile(file, expected));
	const alreadyOpen = before.some((file) => sameFile(file, expected));
	if (addedExpected && !addedOther) return undefined;
	if (addedExpected) return { busy: `another file was opened with SQLite's open of ${path}` };
	if (alreadyOpen)
		return { busy: `SQLite's descriptor of ${path} cannot be told apart while this process has it open` };
	if (addedOther) return { replaced: `SQLite opened another file than the one validated: ${path}` };
	return { replaced: `SQLite holds no descriptor of the validated file: ${path}` };
}

async function nameRefusal(path: string, expected: FileIdentity): Promise<Refusal | undefined> {
	let entry: BigIntStats;
	try {
		entry = await lstat(path, { bigint: true });
	} catch (error: unknown) {
		return { replaced: `cannot inspect ${path} after SQLite opened it: ${(error as Error).message}` };
	}
	if (!entry.isFile() || !sameFile(entry, expected)) return { replaced: `replaced while SQLite opened it: ${path}` };
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
