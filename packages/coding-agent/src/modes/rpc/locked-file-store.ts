/**
 * A durable store kept in one JSON file that several processes may open at once (two daemon generations under one
 * agent dir during a handover, or several endpoints sharing it). agent-core's memory backend (`openMemoryStore`, which
 * passes the STORE conformance cases) runs over a medium that reads the file fresh on every access. Every claim and
 * commit runs under the repo's cross-process lock (`acquireOwnershipSafeLock` on `<path>.lock`), so each one is a
 * single read-check-write against the current file. Each write is atomic or does not happen: a temp file created
 * exclusively beside the file, fsynced, renamed over it, then the directory fsynced (`syncDirectory`, which skips win32
 * and directories that cannot be synced). When the temp file cannot be created, the write is refused
 * (`LockedFileStoreWriteError`) and the file stays as it was: there is no in-place rewrite a crash could truncate.
 *
 * Ownership: `claimFor(token)` makes `token` the store's owner under the next owner epoch, and is idempotent while
 * `token` still owns it, so a retried claim never moves the epoch twice. A commit under an epoch that is no longer the
 * file's is refused `stale-epoch` (`DurableStoreError`), so a superseded process can never overwrite its successor's
 * state. Each claim first writes the new owner token to a small `<path>.owner` file (atomically), then the state, so
 * `owner()` is one small read: cheap enough to check before every action. A transient read error (EMFILE, EAGAIN and
 * the like) is retried a few times before `owner()` throws `LockedFileStoreReadError`. `watchOwnership(token, onLost)`
 * starts from the claimer's own token and fires once when the owner file names anyone else, or stays unreadable through
 * three re-checks (a watch on the directory, plus a re-check every 2 s for file systems whose watch misses a rename).
 */
import {
	closeSync,
	fsyncSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	watch,
	writeSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createMemoryStoreMedium, openMemoryStore } from "@earendil-works/pi-agent-core";
import type { DurableStore, StoreRecord, StoreValue } from "@earendil-works/pi-agent-core/conformance";
import { syncDirectory } from "../../core/session-file-replace.ts";
import { acquireOwnershipSafeLock } from "./ownership-safe-lock.ts";

type MediumState = ReturnType<typeof createMemoryStoreMedium>["current"];

export interface LockedFileStore extends DurableStore {
	/** Makes `token` the owner under the next epoch, or returns the epoch `token` already owns. */
	claimFor(token: string): Promise<number>;
	/** The token that owns the store on disk now; `undefined` before any claim. */
	owner(): Promise<string | undefined>;
	/** Calls `onLost` once, when the owner on disk stops being `token`; returns the stop. */
	watchOwnership(token: string, onLost: () => void): () => void;
}

export interface LockedFileStoreOptions {
	/** Reads a file as text (default `readFileSync`); a test injects read errors here. */
	readonly readText?: (path: string) => string;
}

/** Read errors that pass on their own, retried before an owner read gives up. */
const TRANSIENT_READ_ERRORS = new Set(["EMFILE", "ENFILE", "EAGAIN", "EBUSY", "EINTR"]);
const OWNER_READ_ATTEMPTS = 3;
/** Consecutive unreadable re-checks after which the watch treats ownership as lost. */
const OWNER_UNREADABLE_LIMIT = 3;

export class LockedFileStoreReadError extends Error {
	readonly code = "store_read_failed" as const;
	constructor(path: string, cause: unknown) {
		super(`the store's owner file ${path} could not be read (${String(cause)})`);
		this.name = "LockedFileStoreReadError";
	}
}

/** How often the owner is re-read when no watch event came: a bound for a file system whose watch misses a rename. */
const OWNER_RECHECK_MS = 2_000;

export class LockedFileStoreWriteError extends Error {
	readonly code = "store_write_refused" as const;
	constructor(path: string, cause: unknown) {
		super(`the store file ${path} was not written: its temp file could not be created (${String(cause)})`);
		this.name = "LockedFileStoreWriteError";
	}
}

export class LockedFileStoreCorruptError extends Error {
	constructor(path: string, reason: string) {
		super(`the store file ${path} is unreadable: ${reason}`);
		this.name = "LockedFileStoreCorruptError";
	}
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown, minimum: number): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;

function decodeRecord(value: unknown): StoreRecord | undefined {
	if (!isRecord(value) || !isCount(value.seq, 1) || typeof value.id !== "string" || typeof value.kind !== "string")
		return undefined;
	return { seq: value.seq, id: value.id, kind: value.kind, data: (value.data ?? null) as StoreValue };
}

/** The file's owner and state; an absent or empty file is a store nothing has claimed. Anything else malformed throws. */
function readFileState(path: string): { readonly owner: string | undefined; readonly state: MediumState } {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		text = "";
	}
	if (text === "") return { owner: undefined, state: createMemoryStoreMedium().current };
	const corrupt = (reason: string) => new LockedFileStoreCorruptError(path, reason);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw corrupt("not JSON");
	}
	if (!isRecord(parsed)) throw corrupt("not an object");
	const { owner, epoch, records, documents } = parsed;
	if (typeof owner !== "string" || owner === "") throw corrupt("no owner");
	if (!isCount(epoch, 1)) throw corrupt("the epoch is not an integer of at least 1");
	if (!Array.isArray(records) || !Array.isArray(documents)) throw corrupt("no records or documents");
	const decodedRecords = records.map(decodeRecord);
	if (decodedRecords.some((record) => record === undefined)) throw corrupt("a malformed record");
	const entries: [string, StoreValue][] = [];
	for (const entry of documents) {
		if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string")
			throw corrupt("a malformed document");
		entries.push([entry[0], entry[1] as StoreValue]);
	}
	return { owner, state: { epoch, records: decodedRecords as StoreRecord[], documents: new Map(entries) } };
}

function writeFileState(path: string, owner: string | undefined, state: MediumState): void {
	const { epoch, records, documents } = state;
	writeAtomically(path, JSON.stringify({ owner, epoch, records, documents: [...documents] }));
}

const ownerPath = (path: string): string => `${path}.owner`;

function writeAtomically(path: string, text: string): void {
	const temp = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}.tmp`);
	let fd: number;
	try {
		fd = openSync(temp, "wx", 0o600);
	} catch (error) {
		throw new LockedFileStoreWriteError(path, error);
	}
	try {
		try {
			writeSync(fd, text);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
	syncDirectory(dirname(path));
}

/** Temp files of `path` a writer left by crashing before its rename; only called while holding the lock. */
function removeStaleTemps(path: string): void {
	const prefix = `.${basename(path)}.`;
	for (const name of readdirSync(dirname(path)))
		if (name.startsWith(prefix) && name.endsWith(".tmp")) rmSync(join(dirname(path), name), { force: true });
}

export function openLockedFileStore(path: string, options: LockedFileStoreOptions = {}): LockedFileStore {
	const readText = options.readText ?? ((file: string) => readFileSync(file, "utf8"));
	// The owner file is replaced whole (atomic rename), so a read sees one token or none.
	const owner = async (): Promise<string | undefined> => {
		for (let attempt = 1; ; attempt++) {
			try {
				return readText(ownerPath(path)).trim() || undefined;
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code ?? "";
				if (code === "ENOENT") return undefined;
				if (!TRANSIENT_READ_ERRORS.has(code) || attempt >= OWNER_READ_ATTEMPTS)
					throw new LockedFileStoreReadError(ownerPath(path), error);
				await new Promise<void>((resolve) => setTimeout(resolve, 10 * attempt));
			}
		}
	};
	const medium = {
		get current(): MediumState {
			return readFileState(path).state;
		},
		set current(state: MediumState) {
			writeFileState(path, readFileState(path).owner, state);
		},
	};
	const inner = openMemoryStore(medium);
	const locked = async <T>(run: () => T | Promise<T>): Promise<T> => {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		// Created empty and owner-only once; every atomic replace keeps the mode of the file it replaces.
		await writeFile(path, "", { flag: "a", mode: 0o600 });
		const release = await acquireOwnershipSafeLock(`${path}.lock`);
		try {
			return await run();
		} finally {
			await release();
		}
	};
	return {
		readEpoch: () => inner.readEpoch(),
		readHead: () => inner.readHead(),
		claim: (expected, next) => locked(() => inner.claim(expected, next)),
		commit: (epoch, writes, adopt) => locked(() => inner.commit(epoch, writes, adopt)),
		mintId: () => inner.mintId(),
		scanRecords: (query) => inner.scanRecords(query),
		getDocument: (key) => inner.getDocument(key),
		scanDocuments: (prefix) => inner.scanDocuments(prefix),
		exportSnapshot: () => inner.exportSnapshot(),
		importSnapshot: (epoch, snapshot) => locked(() => inner.importSnapshot(epoch, snapshot)),
		claimFor: (token) =>
			locked(async () => {
				removeStaleTemps(path);
				const { owner: recorded, state } = readFileState(path);
				if (recorded === token && (await owner()) === token) return state.epoch;
				const epoch = state.epoch + 1;
				// The owner file first: a crash between the two writes leaves the old owner already superseded.
				writeAtomically(ownerPath(path), token);
				writeFileState(path, token, { ...state, epoch });
				return epoch;
			}),
		owner,
		watchOwnership(token, onLost) {
			let stopped = false;
			let unreadable = 0;
			const lose = (): void => {
				if (stopped) return;
				stop();
				onLost();
			};
			const recheck = (): void => {
				if (stopped) return;
				owner().then(
					(now) => {
						unreadable = 0;
						if (now !== token) lose();
					},
					() => {
						unreadable += 1;
						if (unreadable >= OWNER_UNREADABLE_LIMIT) lose();
					},
				);
			};
			const watcher = watch(dirname(path), (_event, name) => {
				if (name === null || name === basename(ownerPath(path))) recheck();
			});
			watcher.on("error", recheck);
			const timer = setInterval(recheck, OWNER_RECHECK_MS);
			timer.unref();
			const stop = (): void => {
				stopped = true;
				clearInterval(timer);
				watcher.close();
			};
			recheck();
			return stop;
		},
	};
}
