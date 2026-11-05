/**
 * The DurableStore contract of the durable core (packages/agent/docs/durable-core-adr.md). Every backend (memory, Bun
 * SQLite, Durable Object SQLite) implements it and passes the STORE and KILL-STORE conformance cases.
 *
 * The store does not serialize concurrent writers: a single admission line above it (store-admission.ts) does.
 */

/** A JSON value as the store persists it. */
export type StoreValue =
	| null
	| boolean
	| number
	| string
	| readonly StoreValue[]
	| { readonly [key: string]: StoreValue };

/** One log record. `seq` is assigned by the store: gapless from 1, in commit order. `id` is unique in the log. */
export interface StoreRecord {
	readonly seq: number;
	readonly id: string;
	readonly kind: string;
	readonly data: StoreValue;
}

export interface StoreDocument {
	readonly key: string;
	readonly data: StoreValue;
}

export type StoreWrite =
	| { readonly op: "append"; readonly id: string; readonly kind: string; readonly data: StoreValue }
	| { readonly op: "put"; readonly key: string; readonly data: StoreValue }
	| { readonly op: "delete"; readonly key: string };

export interface CommitResult {
	/** The sequence numbers of the batch's appends, in write order. */
	readonly seqs: readonly number[];
	/** The last committed sequence number after this batch (0 for an empty log). */
	readonly head: number;
}

/** Everything a store holds; the unit of claim + import between hosts. */
export interface StoreSnapshot {
	readonly epoch: number;
	readonly head: number;
	/** Every record, ascending by `seq`. */
	readonly records: readonly StoreRecord[];
	/** Every document, ascending by `key`. */
	readonly documents: readonly StoreDocument[];
}

export interface RecordScan {
	readonly fromSeq?: number;
	readonly toSeq?: number;
	readonly kind?: string;
	readonly order?: "asc" | "desc";
	readonly limit?: number;
}

export type StoreOperation = "commit" | "claim" | "import";

/**
 * A point inside a durable write. `before`: nothing of the operation is durable yet. `write`: inside the atomic unit,
 * before write `index` is staged. `durable`: the operation is durable, before `adopt` runs and before it resolves.
 */
export type StoreWritePoint =
	| { readonly op: StoreOperation; readonly at: "before" }
	| { readonly op: "commit" | "import"; readonly at: "write"; readonly index: number }
	| { readonly op: StoreOperation; readonly at: "durable" };

export interface DurableStoreOptions {
	/**
	 * Test seam for cuts and kills: called at every write point. A throw at `before` or `write` leaves nothing of the
	 * operation durable; a throw at `durable` leaves all of it durable and skips `adopt`.
	 */
	readonly onWritePoint?: (point: StoreWritePoint) => void;
}

export type DurableStoreErrorCode =
	| "unclaimed"
	| "stale-epoch"
	| "invalid-claim"
	| "duplicate-record-id"
	| "import-conflict";

export class DurableStoreError extends Error {
	readonly code: DurableStoreErrorCode;

	constructor(code: DurableStoreErrorCode, message: string) {
		super(message);
		this.name = "DurableStoreError";
		this.code = code;
	}
}

export interface DurableStore {
	/** The current owner epoch; 0 when the store was never claimed. */
	readEpoch(): Promise<number>;
	/** The last committed sequence number; 0 for an empty log. */
	readHead(): Promise<number>;
	/**
	 * Compare-and-set the owner epoch from `expectedEpoch` to `nextEpoch`, which must be exactly `expectedEpoch + 1`; any
	 * other `nextEpoch` (equal, lower, or skipping an epoch) is refused (`invalid-claim`) and changes nothing. A claimant
	 * whose expected epoch is no longer current is refused (`stale-epoch`), so an old owner can never take the store back.
	 */
	claim(expectedEpoch: number, nextEpoch: number): Promise<void>;
	/**
	 * Commit a batch atomically under the owner `epoch`: all of it becomes durable, or none of it. `adopt` runs exactly
	 * once, after the batch is durable and before the commit resolves, and never for a batch that did not become
	 * durable. A commit from any epoch but the current one is refused (`stale-epoch`) and leaves the store unchanged.
	 */
	commit(epoch: number, writes: readonly StoreWrite[], adopt: (result: CommitResult) => void): Promise<CommitResult>;
	/** A new ID, unique across instances, reopens and hosts. */
	mintId(): string;
	scanRecords(query?: RecordScan): Promise<StoreRecord[]>;
	getDocument(key: string): Promise<StoreValue | undefined>;
	/** Documents whose key starts with `prefix`, ascending by key. */
	scanDocuments(prefix: string): Promise<StoreDocument[]>;
	exportSnapshot(): Promise<StoreSnapshot>;
	/**
	 * Import another host's snapshot under this store's current owner `epoch`, which must be above the snapshot's.
	 * Atomic. The store's records must be a prefix of the snapshot's: records past the store's head are imported once,
	 * in order, with their seqs and IDs; documents become the snapshot's. Importing the same snapshot again is a no-op.
	 */
	importSnapshot(epoch: number, snapshot: StoreSnapshot): Promise<void>;
}
