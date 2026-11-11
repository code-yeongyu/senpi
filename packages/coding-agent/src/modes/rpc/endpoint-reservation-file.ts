/**
 * The endpoint reservation store's database file (sisyphuslabs/omo-desktop-app#4199, design 4.2a): created owner-only,
 * validated through a no-follow descriptor, then opened by SQLite, which reopens it by name.
 *
 * Precondition: the store's directory is private to this user. Each check below holds when it runs; a writer in that
 * directory could still replace the journal name later.
 */
import { constants, type Stats } from "node:fs";
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
 * is the validated one (`openExpectedFile`: SQLite's own descriptor on Linux and macOS, the name everywhere). Nothing is
 * read before the journal check, so SQLite has not looked at the journal yet.
 */
export async function openReservationDatabase(path: string): Promise<Database> {
	const validated = await precreatePrivate(path);
	const database = await openDatabase(path, validated);
	try {
		await validateJournal(`${path}-journal`);
	} catch (error: unknown) {
		database.close();
		throw error;
	}
	return database;
}

/** bun:sqlite inside the Bun binary, node:sqlite under Node; the same loading boundary as ownership-safe-lock.ts. */
async function openDatabase(path: string, validated: FileIdentity): Promise<Database> {
	if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
		const { Database } = await import("bun:sqlite");
		const database = checked(
			path,
			validated,
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
	const database = checked(
		path,
		validated,
		() => new DatabaseSync(path),
		(opened) => opened.close(),
	);
	return {
		exec: (sql) => database.exec(sql),
		prepare: (sql) => database.prepare(sql) as unknown as Statement,
		close: () => database.close(),
	};
}

function checked<T>(path: string, validated: FileIdentity, open: () => T, close: (opened: T) => void): T {
	const result = openExpectedFile(path, validated, open, close);
	if ("replaced" in result) throw new EndpointReservationError("store_insecure", result.replaced);
	return result.opened;
}

/**
 * Creates the database file owner-only when absent and validates an existing one through a no-follow descriptor before
 * SQLite opens it: a regular file, owned by this user, with no group or other permission bits (POSIX). Windows DACL
 * validation belongs to the native bridge and is not done here.
 */
async function precreatePrivate(path: string): Promise<FileIdentity> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(path, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
	} catch (error: unknown) {
		throw new EndpointReservationError("store_insecure", `cannot open ${path}: ${(error as Error).message}`);
	}
	try {
		const info = await handle.stat({ bigint: true });
		if (!info.isFile()) throw new EndpointReservationError("store_insecure", `not a regular file: ${path}`);
		refuseShared(Number(info.uid), Number(info.mode), path);
		return { dev: info.dev, ino: info.ino };
	} finally {
		await handle.close();
	}
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
