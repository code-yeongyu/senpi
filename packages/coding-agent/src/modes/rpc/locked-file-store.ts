/**
 * A durable store kept in one JSON file that several processes may open at once (two daemon generations under one
 * agent dir during a handover, or several endpoints sharing it). agent-core's memory backend (`openMemoryStore`, which
 * passes the STORE conformance cases) runs over a medium that reads the file fresh on every access. Every claim and
 * commit runs under the repo's cross-process lock (`acquireOwnershipSafeLock` on `<path>.lock`), so each one is a
 * single read-check-write against the current file. Each write replaces the file atomically (`replaceFileAtomically`:
 * a temp file, fsync, rename, then a directory fsync where the platform supports one).
 *
 * Ownership: `claimFor(token)` makes `token` the store's owner under the next owner epoch, and is idempotent while
 * `token` still owns it, so a retried claim never moves the epoch twice. A commit under an epoch that is no longer the
 * file's is refused `stale-epoch` (`DurableStoreError`), so a superseded process can never overwrite its successor's
 * state. `owner()` reads the current owner, for a process that must stop acting once it is superseded.
 */
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { createMemoryStoreMedium, openMemoryStore } from "@earendil-works/pi-agent-core";
import type { DurableStore, StoreRecord, StoreValue } from "@earendil-works/pi-agent-core/conformance";
import { replaceFileAtomically } from "../../core/session-file-replace.ts";
import { acquireOwnershipSafeLock } from "./ownership-safe-lock.ts";

type MediumState = ReturnType<typeof createMemoryStoreMedium>["current"];

export interface LockedFileStore extends DurableStore {
	/** Makes `token` the owner under the next epoch, or returns the epoch `token` already owns. */
	claimFor(token: string): Promise<number>;
	/** The token that owns the store on disk now; `undefined` before any claim. */
	owner(): Promise<string | undefined>;
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
	replaceFileAtomically(path, [JSON.stringify({ owner, epoch, records, documents: [...documents] })]);
}

/** Temp files of `path` a writer left by crashing before its rename; only called while holding the lock. */
function removeStaleTemps(path: string): void {
	const prefix = `.${basename(path)}.`;
	for (const name of readdirSync(dirname(path)))
		if (name.startsWith(prefix) && name.endsWith(".tmp")) rmSync(join(dirname(path), name), { force: true });
}

export function openLockedFileStore(path: string): LockedFileStore {
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
			locked(() => {
				removeStaleTemps(path);
				const { owner, state } = readFileState(path);
				if (owner === token) return state.epoch;
				const epoch = state.epoch + 1;
				writeFileState(path, token, { ...state, epoch });
				return epoch;
			}),
		owner: async () => readFileState(path).owner,
	};
}
