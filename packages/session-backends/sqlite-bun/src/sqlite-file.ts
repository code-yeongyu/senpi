import { Database, type Statement } from "bun:sqlite";
import type { StoreValue } from "@earendil-works/pi-agent-core/conformance";

const SCHEMA_VERSION = 1;

interface RecordRow {
	readonly seq: number;
	readonly id: string;
	readonly kind: string;
	readonly data: string;
}

interface DocumentRow {
	readonly key: string;
	readonly data: string;
}

export interface StoreStatements {
	readonly epoch: Statement<{ readonly epoch: number }>;
	readonly setEpoch: Statement<never>;
	readonly head: Statement<{ readonly head: number }>;
	readonly hasRecord: Statement<{ readonly found: number }>;
	readonly insertRecord: Statement<never>;
	readonly allRecords: Statement<RecordRow>;
	readonly document: Statement<DocumentRow>;
	readonly documentsWithPrefix: Statement<DocumentRow>;
	readonly putDocument: Statement<never>;
	readonly deleteDocument: Statement<never>;
	readonly deleteAllDocuments: Statement<never>;
}

/**
 * Opens (creating when absent) a store file. WAL with `synchronous=FULL`: a transaction is on disk when COMMIT returns,
 * and a process killed at any point recovers to the last committed transaction on the next open.
 */
export function openStoreFile(path: string): { readonly db: Database; readonly statements: StoreStatements } {
	const db = new Database(path, { create: true });
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = FULL");
	db.transaction(() => {
		const version = db.query<{ readonly user_version: number }>("PRAGMA user_version").get()?.user_version ?? 0;
		if (version > SCHEMA_VERSION) {
			throw new Error(`store file schema ${version} is newer than this backend's ${SCHEMA_VERSION}`);
		}
		db.exec(
			"CREATE TABLE IF NOT EXISTS store_meta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), epoch INTEGER NOT NULL)",
		);
		db.exec("INSERT OR IGNORE INTO store_meta (singleton, epoch) VALUES (1, 0)");
		db.exec(
			"CREATE TABLE IF NOT EXISTS store_records (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, data TEXT NOT NULL)",
		);
		db.exec("CREATE TABLE IF NOT EXISTS store_documents (key TEXT PRIMARY KEY, data TEXT NOT NULL)");
		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	}).immediate();

	const statements: StoreStatements = {
		epoch: db.query("SELECT epoch FROM store_meta WHERE singleton = 1"),
		setEpoch: db.query("UPDATE store_meta SET epoch = ? WHERE singleton = 1"),
		head: db.query("SELECT COALESCE(MAX(seq), 0) AS head FROM store_records"),
		hasRecord: db.query("SELECT 1 AS found FROM store_records WHERE id = ?"),
		insertRecord: db.query("INSERT INTO store_records (seq, id, kind, data) VALUES (?, ?, ?, ?)"),
		allRecords: db.query("SELECT seq, id, kind, data FROM store_records ORDER BY seq"),
		document: db.query("SELECT key, data FROM store_documents WHERE key = ?"),
		documentsWithPrefix: db.query("SELECT key, data FROM store_documents WHERE substr(key, 1, length(?1)) = ?1"),
		putDocument: db.query(
			"INSERT INTO store_documents (key, data) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET data = excluded.data",
		),
		deleteDocument: db.query("DELETE FROM store_documents WHERE key = ?"),
		deleteAllDocuments: db.query("DELETE FROM store_documents"),
	};
	return { db, statements };
}

export const encodeValue = (value: StoreValue): string => JSON.stringify(value);

export const decodeValue = (text: string): StoreValue => JSON.parse(text);

export const decodeRecord = (row: RecordRow) => ({
	seq: row.seq,
	id: row.id,
	kind: row.kind,
	data: decodeValue(row.data),
});

export const decodeDocument = (row: DocumentRow) => ({ key: row.key, data: decodeValue(row.data) });

/** The memory backend's key order (UTF-16 code units), so every backend lists documents identically. */
export const byKey = (a: { readonly key: string }, b: { readonly key: string }): number =>
	a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

/** JSON with sorted object keys: two values are the same store value exactly when their canonical forms are equal. */
export function canonicalJson(value: StoreValue): string {
	if (isList(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const keys = Object.keys(value).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}

const isList = (value: StoreValue): value is readonly StoreValue[] => Array.isArray(value);
