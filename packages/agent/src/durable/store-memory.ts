import {
	type CommitResult,
	type DurableStore,
	DurableStoreError,
	type DurableStoreOptions,
	type RecordScan,
	type StoreDocument,
	type StoreRecord,
	type StoreSnapshot,
	type StoreValue,
	type StoreWritePoint,
} from "./store.ts";

interface MediumState {
	readonly epoch: number;
	readonly records: readonly StoreRecord[];
	readonly documents: ReadonlyMap<string, StoreValue>;
}

/** The memory backend's durable medium. It outlives every store opened on it, so a kill is dropping an instance. */
export interface MemoryStoreMedium {
	current: MediumState;
}

export function createMemoryStoreMedium(): MemoryStoreMedium {
	return { current: { epoch: 0, records: [], documents: new Map() } };
}

const copy = <T extends StoreValue>(value: T): T => structuredClone(value);
const copyRecord = (record: StoreRecord): StoreRecord => ({ ...record, data: copy(record.data) });

const isList = (value: StoreValue): value is readonly StoreValue[] => Array.isArray(value);

function sameValue(a: StoreValue | undefined, b: StoreValue | undefined): boolean {
	if (a === undefined || b === undefined || a === null || b === null) return a === b;
	if (typeof a !== "object" || typeof b !== "object") return a === b;
	if (isList(a) || isList(b)) {
		return isList(a) && isList(b) && a.length === b.length && a.every((item, index) => sameValue(item, b[index]));
	}
	const keys = Object.keys(a);
	return (
		keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameValue(a[key], b[key]))
	);
}

const sameRecord = (a: StoreRecord, b: StoreRecord | undefined): boolean =>
	b !== undefined && a.seq === b.seq && a.id === b.id && a.kind === b.kind && sameValue(a.data, b.data);

function requireOwner(state: MediumState, epoch: number): void {
	if (state.epoch === 0) throw new DurableStoreError("unclaimed", "the store has no owner; claim it first");
	if (epoch !== state.epoch) {
		throw new DurableStoreError("stale-epoch", `epoch ${epoch} is not the owner epoch ${state.epoch}`);
	}
}

function importedTail(state: MediumState, snapshot: StoreSnapshot): readonly StoreRecord[] {
	const ids = new Set<string>();
	const wellFormed =
		snapshot.head === snapshot.records.length &&
		snapshot.records.every((record, index) => record.seq === index + 1 && !ids.has(record.id) && ids.add(record.id));
	const extendsLog =
		state.records.length <= snapshot.records.length &&
		state.records.every((record, index) => sameRecord(record, snapshot.records[index]));
	if (!wellFormed || !extendsLog) {
		throw new DurableStoreError("import-conflict", "the snapshot's log does not extend this store's log");
	}
	return snapshot.records.slice(state.records.length);
}

function scan(records: readonly StoreRecord[], query: RecordScan): StoreRecord[] {
	const matching = records.filter(
		(record) =>
			(query.fromSeq === undefined || record.seq >= query.fromSeq) &&
			(query.toSeq === undefined || record.seq <= query.toSeq) &&
			(query.kind === undefined || record.kind === query.kind),
	);
	const ordered = query.order === "desc" ? matching.reverse() : matching;
	return (query.limit === undefined ? ordered : ordered.slice(0, query.limit)).map(copyRecord);
}

const documentsOf = (state: MediumState, prefix: string): StoreDocument[] =>
	[...state.documents]
		.filter(([key]) => key.startsWith(prefix))
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([key, data]) => ({ key, data: copy(data) }));

/** A DurableStore over `medium`. Each operation stages its writes and publishes them in one assignment: atomic. */
export function openMemoryStore(medium: MemoryStoreMedium, options: DurableStoreOptions = {}): DurableStore {
	const point = (at: StoreWritePoint): void => options.onWritePoint?.(at);

	return {
		readEpoch: async () => medium.current.epoch,
		readHead: async () => medium.current.records.length,

		async claim(expectedEpoch, nextEpoch) {
			point({ op: "claim", at: "before" });
			const state = medium.current;
			if (!Number.isSafeInteger(nextEpoch) || nextEpoch !== expectedEpoch + 1) {
				throw new DurableStoreError(
					"invalid-claim",
					`a claim must raise the epoch to exactly ${expectedEpoch + 1}`,
				);
			}
			if (state.epoch !== expectedEpoch) {
				throw new DurableStoreError(
					"stale-epoch",
					`expected epoch ${expectedEpoch}, the owner epoch is ${state.epoch}`,
				);
			}
			medium.current = { ...state, epoch: nextEpoch };
			point({ op: "claim", at: "durable" });
		},

		async commit(epoch, writes, adopt) {
			point({ op: "commit", at: "before" });
			const state = medium.current;
			requireOwner(state, epoch);
			const records = [...state.records];
			const ids = new Set(records.map((record) => record.id));
			const documents = new Map(state.documents);
			const seqs: number[] = [];
			writes.forEach((write, index) => {
				point({ op: "commit", at: "write", index });
				switch (write.op) {
					case "append": {
						if (ids.has(write.id))
							throw new DurableStoreError("duplicate-record-id", `record ${write.id} exists`);
						ids.add(write.id);
						const seq = records.length + 1;
						records.push({ seq, id: write.id, kind: write.kind, data: copy(write.data) });
						seqs.push(seq);
						break;
					}
					case "put":
						documents.set(write.key, copy(write.data));
						break;
					case "delete":
						documents.delete(write.key);
						break;
				}
			});
			medium.current = { epoch: state.epoch, records, documents };
			point({ op: "commit", at: "durable" });
			const result: CommitResult = { seqs, head: records.length };
			adopt(result);
			return result;
		},

		mintId: () => crypto.randomUUID(),
		scanRecords: async (query = {}) => scan(medium.current.records, query),
		getDocument: async (key) => {
			const data = medium.current.documents.get(key);
			return data === undefined ? undefined : copy(data);
		},
		scanDocuments: async (prefix) => documentsOf(medium.current, prefix),
		exportSnapshot: async () => {
			const state = medium.current;
			return {
				epoch: state.epoch,
				head: state.records.length,
				records: state.records.map(copyRecord),
				documents: documentsOf(state, ""),
			};
		},

		async importSnapshot(epoch, snapshot) {
			point({ op: "import", at: "before" });
			const state = medium.current;
			requireOwner(state, epoch);
			if (epoch <= snapshot.epoch) {
				throw new DurableStoreError(
					"invalid-claim",
					`epoch ${epoch} is not above the source epoch ${snapshot.epoch}`,
				);
			}
			const records = [...state.records];
			const documents = new Map<string, StoreValue>();
			let index = 0;
			for (const record of importedTail(state, snapshot)) {
				point({ op: "import", at: "write", index: index++ });
				records.push(copyRecord(record));
			}
			for (const document of snapshot.documents) {
				point({ op: "import", at: "write", index: index++ });
				documents.set(document.key, copy(document.data));
			}
			medium.current = { epoch: state.epoch, records, documents };
			point({ op: "import", at: "durable" });
		},
	};
}
