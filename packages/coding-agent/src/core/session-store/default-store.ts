import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
	DurableStoreError,
	type DurableStoreOptions,
	type StoreWritePoint,
	type SyncCommitStore,
} from "@earendil-works/pi-agent-core";
import { type BunSqliteMedia, createBunSqliteMedia } from "@earendil-works/pi-storage-sqlite-bun";
import { defaultSessionStoreMedium } from "./default-store-path.ts";

/** A session's default durable store, bound at the epoch its writes carry. */
export interface DefaultSessionStore {
	readonly store: SyncCommitStore;
	readonly epoch: number;
}

export interface DefaultSessionStoreOptions {
	readonly agentDir: string;
	/** The directory holding the session's JSONL file: a session id is unique only within it (one per project). */
	readonly sessionDir: string;
	readonly sessionId: string;
	readonly onWritePoint?: (point: StoreWritePoint) => void;
}

const medias = new Map<string, BunSqliteMedia>();

function mediaUnder(root: string): BunSqliteMedia {
	const existing = medias.get(root);
	if (existing !== undefined) return existing;
	const created = createBunSqliteMedia(root);
	medias.set(root, created);
	return created;
}

const stores = new Map<string, Promise<SyncCommitStore>>();

/**
 * One connection per session medium per process: binding a session again (/resume, a reload, the startup retry) reuses
 * it instead of opening another that nothing would close. A write-point hook (kill-point tests) gets its own connection.
 */
function storeFor(root: string, medium: string, options: DurableStoreOptions | undefined): Promise<SyncCommitStore> {
	if (options !== undefined) return mediaUnder(root).open(medium, options);
	const existing = stores.get(medium);
	if (existing !== undefined) return existing;
	const opened = mediaUnder(root).open(medium);
	stores.set(medium, opened);
	opened.catch(() => stores.delete(medium));
	return opened;
}

const lostRace = (error: unknown): boolean => error instanceof DurableStoreError && error.code === "stale-epoch";

/**
 * Opens the session's own medium (`defaultSessionStoreMedium`; the epoch never crosses sessions). A fresh medium is
 * claimed 0->1; otherwise, or when a peer won the fresh claim, the process binds at the current epoch, so
 * co-bound processes keep writing and sqlite serializes their transactions.
 */
export async function openDefaultSessionStore(options: DefaultSessionStoreOptions): Promise<DefaultSessionStore> {
	const medium = defaultSessionStoreMedium(options.agentDir, options.sessionDir, options.sessionId);
	const root = join(options.agentDir, "session-store");
	await mkdir(medium, { recursive: true, mode: 0o700 });
	const storeOptions: DurableStoreOptions | undefined =
		options.onWritePoint === undefined ? undefined : { onWritePoint: options.onWritePoint };
	const store = await storeFor(root, medium, storeOptions);
	const current = await store.readEpoch();
	if (current > 0) return { store, epoch: current };
	try {
		await store.claim(0, 1);
		return { store, epoch: 1 };
	} catch (error) {
		if (!lostRace(error)) throw error;
		return { store, epoch: await store.readEpoch() };
	}
}

/** A takeover: raises the session's epoch, which fences every process still bound at the old one. */
export async function takeOverSessionStore(bound: DefaultSessionStore): Promise<DefaultSessionStore> {
	const current = await bound.store.readEpoch();
	await bound.store.claim(current, current + 1);
	return { store: bound.store, epoch: current + 1 };
}
