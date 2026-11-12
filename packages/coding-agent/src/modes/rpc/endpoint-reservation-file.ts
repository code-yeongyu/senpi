/**
 * The endpoint reservation store's database file (sisyphuslabs/omo-desktop-app#4199, design 4.2a): created owner-only,
 * validated through a no-follow descriptor, then opened by SQLite, which reopens it by name.
 *
 * Precondition: the store's directory is private to this user. Each check below holds when it runs; a writer in that
 * directory could still replace the journal name later.
 */
import { type BigIntStats, constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { EndpointReservationError } from "./endpoint-reservation-error.ts";
import { type FileIdentity, openExpectedFile } from "./sqlite-file-identity.ts";

export interface Statement {
	run(...params: unknown[]): unknown;
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
}

export interface Database {
	exec(sql: string): void;
	prepare(sql: string): Statement;
	close(): void;
}

/**
 * Opens the store at `path` once the file and its rollback journal are validated, and only when the file SQLite opened
 * is the validated one (`openExpectedFile`: SQLite's own descriptor on Linux and macOS, the name everywhere). The file's
 * validation runs inside that checked open, with SQLite's. Nothing is read before the journal check, so SQLite has not
 * looked at the journal yet.
 */
export async function openReservationDatabase(path: string): Promise<Database> {
	const database = await openDatabase(path);
	try {
		await validateJournal(`${path}-journal`);
	} catch (error: unknown) {
		database.close();
		throw error;
	}
	return database;
}

/** bun:sqlite inside the Bun binary, node:sqlite under Node; the same loading boundary as ownership-safe-lock.ts. */
async function openDatabase(path: string): Promise<Database> {
	if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
		const { Database } = await import("bun:sqlite");
		const database = await checked(
			path,
			() => new Database(path),
			(opened) => opened.close(false),
		);
		return {
			exec: (sql) => database.exec(sql),
			prepare: (sql) => database.prepare(sql) as unknown as Statement,
			close: () => database.close(false),
		};
	}
	const { DatabaseSync } = await import("node:sqlite");
	const database = await checked(
		path,
		() => new DatabaseSync(path),
		(opened) => opened.close(),
	);
	return {
		exec: (sql) => database.exec(sql),
		prepare: (sql) => database.prepare(sql) as unknown as Statement,
		close: () => database.close(),
	};
}

async function checked<T>(path: string, open: () => T, close: (opened: T) => void): Promise<T> {
	const result = await openExpectedFile(path, () => precreatePrivate(path), open, close);
	if ("replaced" in result) throw new EndpointReservationError("store_insecure", result.replaced);
	// Not provable now: the descriptor listings could not single out SQLite's descriptor, because this process opened
	// another file during the open, or the store was already open here and SQLite added no descriptor of it, or the
	// listing after the open failed. A holder connection alone is not busy when SQLite adds a new descriptor of the
	// store. store_busy, which retryWhenBusy retries and refuses at its bound, never an open of an unproven file.
	if ("busy" in result) throw new EndpointReservationError("store_busy", result.busy);
	return result.opened;
}

/**
 * Creates the database file owner-only when absent and validates it before SQLite opens it: a regular file, owned by
 * this user, with no group or other permission bits (POSIX). An existing file is checked by `lstat`, never opened:
 * closing a descriptor of it would drop the locks a store connection of this process holds on it (senpi#6478), and an
 * open of a FIFO would block. Windows DACL validation belongs to the native bridge and is not done here. Runs as
 * `openExpectedFile`'s `validate`, inside the checked-open section, whose descriptor proof checks SQLite opened exactly
 * this file.
 */
async function precreatePrivate(path: string): Promise<FileIdentity> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		const flags = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
		handle = await open(path, flags | (constants.O_NONBLOCK ?? 0), 0o600);
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
			throw new EndpointReservationError("store_insecure", `cannot open ${path}: ${(error as Error).message}`);
		}
	}
	// A file this call created is new, so closing its descriptor drops no lock.
	const info = handle ? await statAndClose(handle) : await lstat(path, { bigint: true }).catch(cannotInspect(path));
	if (!info.isFile()) throw new EndpointReservationError("store_insecure", `not a regular file: ${path}`);
	refuseShared(Number(info.uid), Number(info.mode), path);
	return { dev: info.dev, ino: info.ino };
}

async function statAndClose(handle: Awaited<ReturnType<typeof open>>): Promise<BigIntStats> {
	try {
		return await handle.stat({ bigint: true });
	} finally {
		await handle.close();
	}
}

function cannotInspect(path: string): (error: unknown) => never {
	return (error) => {
		throw new EndpointReservationError("store_insecure", `cannot inspect ${path}: ${(error as Error).message}`);
	};
}

/**
 * SQLite reads a hot rollback journal back into the database and writes the journal through whatever its name resolves
 * to, so `<path>-journal` must be absent or a private regular file. SQLite creates it with the database file's mode.
 */
async function validateJournal(journal: string): Promise<void> {
	let info: Stats;
	try {
		info = await lstat(journal);
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw new EndpointReservationError("store_insecure", `cannot inspect ${journal}: ${(error as Error).message}`);
	}
	if (!info.isFile()) throw new EndpointReservationError("store_insecure", `not a regular file: ${journal}`);
	refuseShared(info.uid, info.mode, journal);
}

function refuseShared(uid: number, mode: number, path: string): void {
	if (process.platform === "win32") return;
	if (typeof process.getuid === "function" && uid !== process.getuid()) {
		throw new EndpointReservationError("store_insecure", `owned by another user: ${path}`);
	}
	if ((mode & 0o077) !== 0) {
		throw new EndpointReservationError("store_insecure", `readable or writable by others: ${path}`);
	}
}
