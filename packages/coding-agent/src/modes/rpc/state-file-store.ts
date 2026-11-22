/**
 * A durable STATE store in one owner-only JSON file (senpi#6767 review H1/L1), for a process's small durable state: the
 * hand's wake outbox, and the `hand_link` endpoint's state (#6758 converges on it). It is agent-core's memory backend
 * over a medium that keeps the store's documents and owner epoch, never its log: a commit's appends are applied and
 * discarded (no reader of these stores scans records), so the file and every rewrite are bounded by the documents.
 *
 * Every mutation is a locked read-check-write against the disk: it takes the file's cross-process lock
 * (`ownership-safe-lock.ts`), reads the file, checks the epoch there, writes the next state atomically (a temporary
 * file, fsynced, renamed over the old one, the directory fsynced), then releases the lock. A process that claimed the
 * store before a newer one is refused `stale-epoch` and never overwrites the newer state.
 */
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { createMemoryStoreMedium, type MemoryStoreMedium, openMemoryStore } from "@earendil-works/pi-agent-core";
import type { DurableStore, StoreValue } from "@earendil-works/pi-agent-core/conformance";
import { acquireOwnershipSafeLock } from "./ownership-safe-lock.ts";

type MediumState = MemoryStoreMedium["current"];

class StateFileCorruptError extends Error {
	override readonly name = "StateFileCorruptError";
	readonly path: string;
	constructor(path: string, what: string) {
		super(`the state file ${path} is unreadable: ${what}`);
		this.path = path;
	}
}

const isDocument = (value: unknown): value is [string, StoreValue] =>
	Array.isArray(value) && value.length === 2 && typeof value[0] === "string";

function readState(path: string): MediumState {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return createMemoryStoreMedium().current;
		throw error;
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		throw new StateFileCorruptError(path, error instanceof Error ? error.message : String(error));
	}
	const { epoch, documents } = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
	if (typeof epoch !== "number" || !Array.isArray(documents) || !documents.every(isDocument))
		throw new StateFileCorruptError(path, "missing epoch or documents");
	return { epoch, records: [], documents: new Map(documents) };
}

function fsyncPath(path: string, flags: string): void {
	const fd = openSync(path, flags);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

function writeState(path: string, state: MediumState): void {
	const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
	const fd = openSync(temporary, "wx", 0o600);
	try {
		writeSync(fd, JSON.stringify({ epoch: state.epoch, documents: [...state.documents] }));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temporary, path);
	// A directory cannot be opened for fsync on Windows; the rename there is already durable once it returns.
	if (process.platform !== "win32") fsyncPath(dirname(path), "r");
}

/** The state store kept in `path` (its directory is created owner-only); the file is created by the first mutation. */
export function openStateFileStore(path: string): DurableStore {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const medium: MemoryStoreMedium = {
		get current() {
			return readState(path);
		},
		set current(next) {
			writeState(path, next);
		},
	};
	const store = openMemoryStore(medium);
	const locked = async <T>(mutate: () => Promise<T>): Promise<T> => {
		const release = await acquireOwnershipSafeLock(`${path}.lock`);
		try {
			return await mutate();
		} finally {
			await release();
		}
	};
	return {
		...store,
		claim: (expected, next) => locked(() => store.claim(expected, next)),
		commit: (epoch, writes, adopt) => locked(() => store.commit(epoch, writes, adopt)),
		importSnapshot: (epoch, snapshot) => locked(() => store.importSnapshot(epoch, snapshot)),
	};
}

/** Claims the next owner epoch of `store` for this process; an older claimant's later mutations are refused. */
export async function claimStateStore(store: DurableStore): Promise<number> {
	for (;;) {
		const epoch = (await store.readEpoch()) + 1;
		try {
			await store.claim(epoch - 1, epoch);
			return epoch;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "stale-epoch")) throw error;
		}
	}
}
