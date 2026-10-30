import type { Database } from "bun:sqlite";
import {
	type CommitResult,
	type DurableStore,
	DurableStoreError,
	type DurableStoreOptions,
	type RecordScan,
	type StoreRecord,
	type StoreSnapshot,
	type StoreWritePoint,
} from "@earendil-works/pi-agent-core/conformance";
import {
	byKey,
	canonicalJson,
	decodeDocument,
	decodeRecord,
	decodeValue,
	encodeValue,
	openStoreFile,
	type StoreStatements,
} from "./sqlite-file.ts";

function requireOwner(current: number, epoch: number): void {
	if (current === 0) throw new DurableStoreError("unclaimed", "the store has no owner; claim it first");
	if (epoch !== current)
		throw new DurableStoreError("stale-epoch", `epoch ${epoch} is not the owner epoch ${current}`);
}

const sameRecord = (a: StoreRecord, b: StoreRecord | undefined): boolean =>
	b !== undefined &&
	a.seq === b.seq &&
	a.id === b.id &&
	a.kind === b.kind &&
	canonicalJson(a.data) === canonicalJson(b.data);

function importedTail(held: readonly StoreRecord[], snapshot: StoreSnapshot): readonly StoreRecord[] {
	const ids = new Set<string>();
	const wellFormed =
		snapshot.head === snapshot.records.length &&
		snapshot.records.every((record, index) => record.seq === index + 1 && !ids.has(record.id) && ids.add(record.id));
	const extendsLog =
		held.length <= snapshot.records.length &&
		held.every((record, index) => sameRecord(record, snapshot.records[index]));
	if (!wellFormed || !extendsLog) {
		throw new DurableStoreError("import-conflict", "the snapshot's log does not extend this store's log");
	}
	return snapshot.records.slice(held.length);
}

function scanQuery(query: RecordScan): { readonly sql: string; readonly params: (string | number)[] } {
	const conditions: ReadonlyArray<readonly [string, string | number | undefined]> = [
		["seq >= ?", query.fromSeq],
		["seq <= ?", query.toSeq],
		["kind = ?", query.kind],
	];
	const where: string[] = [];
	const params: (string | number)[] = [];
	for (const [condition, value] of conditions) {
		if (value === undefined) continue;
		where.push(condition);
		params.push(value);
	}
	const filter = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
	const limit = query.limit === undefined ? "" : " LIMIT ?";
	if (query.limit !== undefined) params.push(query.limit);
	const order = query.order === "desc" ? "DESC" : "ASC";
	return { sql: `SELECT seq, id, kind, data FROM store_records${filter} ORDER BY seq ${order}${limit}`, params };
}

/** A DurableStore over one SQLite file. Every mutation is one `BEGIN IMMEDIATE` transaction: atomic and durable. */
export function openSqliteStore(
	path: string,
	options: DurableStoreOptions = {},
): { readonly store: DurableStore; readonly db: Database } {
	const { db, statements: q } = openStoreFile(path);
	const point = (at: StoreWritePoint): void => options.onWritePoint?.(at);
	const epochNow = (s: StoreStatements): number => s.epoch.get()?.epoch ?? 0;
	const headNow = (s: StoreStatements): number => s.head.get()?.head ?? 0;
	const allRecords = (): StoreRecord[] => q.allRecords.all().map(decodeRecord);
	const allDocuments = () => q.documentsWithPrefix.all("").map(decodeDocument).sort(byKey);

	const store: DurableStore = {
		readEpoch: async () => epochNow(q),
		readHead: async () => headNow(q),

		async claim(expectedEpoch, nextEpoch) {
			point({ op: "claim", at: "before" });
			if (!Number.isSafeInteger(nextEpoch) || nextEpoch !== expectedEpoch + 1) {
				throw new DurableStoreError(
					"invalid-claim",
					`a claim must raise the epoch to exactly ${expectedEpoch + 1}`,
				);
			}
			db.transaction(() => {
				const current = epochNow(q);
				if (current !== expectedEpoch) {
					throw new DurableStoreError(
						"stale-epoch",
						`expected epoch ${expectedEpoch}, the owner epoch is ${current}`,
					);
				}
				q.setEpoch.run(nextEpoch);
			}).immediate();
			point({ op: "claim", at: "durable" });
		},

		async commit(epoch, writes, adopt) {
			point({ op: "commit", at: "before" });
			const result = db
				.transaction((): CommitResult => {
					requireOwner(epochNow(q), epoch);
					const batchIds = new Set<string>();
					const seqs: number[] = [];
					let head = headNow(q);
					writes.forEach((write, index) => {
						point({ op: "commit", at: "write", index });
						switch (write.op) {
							case "append": {
								if (batchIds.has(write.id) || q.hasRecord.get(write.id) !== null) {
									throw new DurableStoreError("duplicate-record-id", `record ${write.id} exists`);
								}
								batchIds.add(write.id);
								head += 1;
								q.insertRecord.run(head, write.id, write.kind, encodeValue(write.data));
								seqs.push(head);
								break;
							}
							case "put":
								q.putDocument.run(write.key, encodeValue(write.data));
								break;
							case "delete":
								q.deleteDocument.run(write.key);
								break;
						}
					});
					return { seqs, head };
				})
				.immediate();
			point({ op: "commit", at: "durable" });
			adopt(result);
			return result;
		},

		mintId: () => crypto.randomUUID(),

		scanRecords: async (query = {}) => {
			const { sql, params } = scanQuery(query);
			return db
				.query<{ seq: number; id: string; kind: string; data: string }>(sql)
				.all(...params)
				.map(decodeRecord);
		},
		getDocument: async (key) => {
			const row = q.document.get(key);
			return row === null ? undefined : decodeValue(row.data);
		},
		scanDocuments: async (prefix) => q.documentsWithPrefix.all(prefix).map(decodeDocument).sort(byKey),
		exportSnapshot: async () =>
			db
				.transaction(() => {
					const records = allRecords();
					return { epoch: epochNow(q), head: records.length, records, documents: allDocuments() };
				})
				.deferred(),

		async importSnapshot(epoch, snapshot) {
			point({ op: "import", at: "before" });
			db.transaction(() => {
				requireOwner(epochNow(q), epoch);
				if (epoch <= snapshot.epoch) {
					throw new DurableStoreError(
						"invalid-claim",
						`epoch ${epoch} is not above the source epoch ${snapshot.epoch}`,
					);
				}
				let index = 0;
				for (const record of importedTail(allRecords(), snapshot)) {
					point({ op: "import", at: "write", index: index++ });
					q.insertRecord.run(record.seq, record.id, record.kind, encodeValue(record.data));
				}
				q.deleteAllDocuments.run();
				for (const document of snapshot.documents) {
					point({ op: "import", at: "write", index: index++ });
					q.putDocument.run(document.key, encodeValue(document.data));
				}
			}).immediate();
			point({ op: "import", at: "durable" });
		},
	};
	return { store, db };
}
