import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { DurableStore, StoreValue, StoreWrite } from "@earendil-works/pi-agent-core/conformance";
import { type FileEntry, migrateSessionEntries } from "../session-manager.ts";

export type JsonlFileStamp = { size: number; mtimeMs: number; ctimeMs: number };
type HatchMarker = { size: number; mtimeMs: number };
type JsonlObject = { [key: string]: StoreValue };
type JsonlHeader = JsonlObject & { type: "session"; id: string };
/** `key` names the entry in the store; `stored` is what is written there (the migrated JSON for a legacy file). */
type LocatedRecord = { value: StoreValue; key: string; stored: string; raw: string; offset: number; end: number };
type HighWaterMark = { id: string; hash: string; offset: number; end: number };
type Divergence = { kind: "k9f2"; parentSessionId: string; note: string };
type SessionManifest = {
	id: string;
	header: JsonlHeader;
	entryIds: string[];
	divergence: Divergence | null;
};

export type JsonlImportLedger = JsonlFileStamp & {
	path: string;
	sourceSessionId: string;
	sessionId: string;
	highWaterMark: HighWaterMark;
	writerKind: "store" | "hatch" | "other";
	checkedAt: number;
};

export interface JsonlFiles {
	stat(path: string): Promise<JsonlFileStamp>;
	/** Byte range [start, end), not characters. No read may include bytes beyond the captured size. */
	read(path: string, start: number, end: number): Promise<Uint8Array>;
	marker(path: string): Promise<HatchMarker | undefined>;
}

export const jsonlFiles: JsonlFiles = {
	async stat(path) {
		const value = await stat(path);
		return { size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs };
	},
	async read(path, start, end) {
		const file = await open(path, "r");
		try {
			const bytes = Buffer.alloc(end - start);
			let read = 0;
			while (read < bytes.length) {
				const { bytesRead } = await file.read(bytes, read, bytes.length - read, start + read);
				if (bytesRead === 0) break;
				read += bytesRead;
			}
			return bytes.subarray(0, read);
		} finally {
			await file.close();
		}
	},
	async marker(path) {
		try {
			const value: unknown = JSON.parse(await readFile(`${path}.k9f2`, "utf8"));
			if (
				typeof value === "object" &&
				value !== null &&
				"size" in value &&
				typeof value.size === "number" &&
				"mtimeMs" in value &&
				typeof value.mtimeMs === "number"
			)
				return { size: value.size, mtimeMs: value.mtimeMs };
			return undefined;
		} catch (error) {
			if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	},
};

/**
 * S21b writes this after its fenced hatch write, using that write's stamp, never a later observer's stamp.
 * Contract: S21b holds the importer's admission line across the hatch write AND this marker. An import admitted between
 * them would see the write without its marker, adopt it in place as `other`, and then settle on the fast path, so the
 * fork would never happen.
 */
export async function writeHatchMarker(path: string, written: HatchMarker): Promise<void> {
	const temporary = `${path}.k9f2.${randomUUID()}`;
	const file = await open(temporary, "wx", 0o600);
	try {
		try {
			await file.writeFile(JSON.stringify({ size: written.size, mtimeMs: written.mtimeMs }));
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, `${path}.k9f2`);
	} finally {
		await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}

export interface JsonlImporterOptions {
	store: DurableStore;
	epoch: number;
	/** The same admission line S20 uses for session mutations and projection writes. */
	admission: { admit<T>(mutation: () => Promise<T>): Promise<T> };
	files?: JsonlFiles;
	now?: () => number;
	/** Resolution of the source filesystem's mtime, in milliseconds. */
	mtimeTickMs?: number;
}

export type JsonlImportResult = {
	outcome: "imported" | "extended" | "forked" | "adopted" | "unchanged";
	sessionId: string;
	imported: number;
};

const SESSION = "session-import/session/";
const ENTRY = "session-import/entry/";
const LEDGER = "session-import/file/";
const sessionKey = (id: string) => SESSION + encodeURIComponent(id);
const entryKey = (sessionId: string, id: string) =>
	`${ENTRY}${encodeURIComponent(sessionId)}/${encodeURIComponent(id)}`;
const ledgerKey = (path: string) => LEDGER + path;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex").slice(0, 32);
const sameStamp = (a: JsonlFileStamp, b: JsonlFileStamp) =>
	a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

const isObject = (value: StoreValue | undefined): value is JsonlObject =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * SessionManager's v1 -> v2 step with ids derived from position instead of random, so a reopen keeps the ids it
 * imported. Like SessionManager it walks every line after reading (header at index 0), so `firstKeptEntryIndex`
 * resolves the same way. A non-object line is kept but takes no id, and the chain links around it. SessionManager
 * differs (senpi#5214): it throws on a primitive line; it gives an array line an id that JSON drops on save, so the
 * next entry's `parentId` and a `firstKeptEntryId` aimed at that line dangle. Here the next entry links to the previous
 * object entry and that `firstKeptEntryId` stays unset.
 */
function migrateV1(values: StoreValue[]): void {
	let previous: string | null = null;
	let ordinal = 0;
	for (const value of values) {
		if (!isObject(value)) continue;
		const entry = value as { [key: string]: StoreValue | undefined };
		if (entry.type === "session") {
			entry.version = 2;
			continue;
		}
		const id = `legacy-${ordinal++}`;
		entry.id = id;
		entry.parentId = previous;
		previous = id;
		if (entry.type === "compaction" && typeof entry.firstKeptEntryIndex === "number") {
			const target = values[entry.firstKeptEntryIndex];
			if (isObject(target) && target.type !== "session" && typeof target.id === "string") {
				entry.firstKeptEntryId = target.id;
			}
			delete entry.firstKeptEntryIndex;
		}
	}
}

function parse(bytes: Uint8Array): {
	header: Omit<LocatedRecord, "value"> & { value: JsonlHeader };
	entries: LocatedRecord[];
} {
	const lines: { value: StoreValue; raw: string; offset: number; end: number }[] = [];
	let offset = 0;
	for (let end = 0; end <= bytes.length; end++) {
		if (end !== bytes.length && bytes[end] !== 10) continue;
		const raw = Buffer.from(bytes.subarray(offset, end)).toString("utf8");
		let value: StoreValue;
		try {
			value = JSON.parse(raw) as StoreValue;
		} catch {
			offset = end + 1;
			continue; // The legacy reader also skips blank and torn/malformed lines.
		}
		// Like `parseSessionEntryLine`'s caller, a falsy value (null, 0, false, "") is dropped and every other value kept.
		if (value) lines.push({ value, raw, offset, end });
		offset = end + 1;
	}
	const values = lines.map((line) => line.value);
	const first = values[0];
	if (!isObject(first) || first.type !== "session" || typeof first.id !== "string") {
		throw new Error("JSONL session has no header");
	}
	// The same version test and steps as SessionManager's load; only v1's random ids are made positional.
	const version = Number(first.version ?? 1);
	if (version < 2) migrateV1(values);
	if (version < 3) migrateSessionEntries(values as unknown as FileEntry[]);
	const stored = (value: StoreValue, raw: string) => (version < 3 ? JSON.stringify(value) : raw);
	const [headerLine, ...entryLines] = lines;
	const header = { ...headerLine, value: first as JsonlHeader, key: first.id, stored: stored(first, headerLine.raw) };
	const keys = new Set<string>();
	const entries = entryLines.map((line, index): LocatedRecord => {
		if (isObject(line.value) && line.value.type === "session") throw new Error("Duplicate JSONL session entry");
		// SessionManager keeps a line without a string id; the store still needs a key, taken from its position. A real
		// id starting with "~" gets one more "~", so it can never equal a positional `~line-N` key (senpi#5214).
		const id = isObject(line.value) && typeof line.value.id === "string" ? line.value.id : undefined;
		const key = id === undefined ? `~line-${index}` : id.startsWith("~") ? `~${id}` : id;
		if (keys.has(key)) throw new Error("Duplicate JSONL session entry");
		keys.add(key);
		return { ...line, key, stored: stored(line.value, line.raw) };
	});
	return { header, entries };
}

const highWaterMark = (record: Omit<LocatedRecord, "value">): HighWaterMark => ({
	id: record.key,
	hash: hash(record.raw),
	offset: record.offset,
	end: record.end,
});

/**
 * S07's import boundary. All mutations are atomic with their ledger record and serialized with the caller's
 * session admission. It deliberately has no default-store/CLI wiring until S20/S21b.
 */
export function createJsonlImporter(options: JsonlImporterOptions) {
	const { store, epoch, admission } = options;
	const files = options.files ?? jsonlFiles;
	const now = options.now ?? Date.now;
	const tick = options.mtimeTickMs ?? 1;
	const manifest = async (id: string) => (await store.getDocument(sessionKey(id))) as SessionManifest | undefined;
	const ledger = async (path: string) => (await store.getDocument(ledgerKey(path))) as JsonlImportLedger | undefined;
	const heldEntries = async (held: SessionManifest): Promise<StoreValue[]> =>
		Promise.all(
			held.entryIds.map(async (id) => {
				const raw = await store.getDocument(entryKey(held.id, id));
				if (typeof raw !== "string") throw new Error(`Missing imported session entry ${id}`);
				return JSON.parse(raw) as StoreValue;
			}),
		);
	const commit = (writes: StoreWrite[]) => store.commit(epoch, writes, () => {});

	const importFile = async (path: string): Promise<JsonlImportResult> => {
		const stamp = await files.stat(path);
		const previous = await ledger(path);
		if (previous && stamp.size === previous.size) {
			const uncertain = Math.abs(previous.checkedAt - previous.mtimeMs) <= tick;
			const sameMtime = stamp.mtimeMs === previous.mtimeMs;
			let sameHighWater = true;
			if (!sameMtime || uncertain) {
				const hwm = previous.highWaterMark;
				sameHighWater = hash(await files.read(path, hwm.offset, hwm.end)) === hwm.hash;
			}
			// ctime detects edits before the HWM, which its hash alone cannot observe.
			if (sameMtime && sameHighWater && stamp.ctimeMs === previous.ctimeMs) {
				if (uncertain) await commit([{ op: "put", key: ledgerKey(path), data: { ...previous, checkedAt: now() } }]);
				return { outcome: "unchanged", sessionId: previous.sessionId, imported: 0 };
			}
		}

		const bytes = await files.read(path, 0, stamp.size);
		const marker = await files.marker(path);
		if (bytes.length !== stamp.size || !sameStamp(stamp, await files.stat(path))) {
			throw new Error("JSONL session changed during import; reopen it to import the next snapshot");
		}
		const { header, entries } = parse(bytes);
		const sourceSessionId = header.value.id;
		const target = previous?.sourceSessionId === sourceSessionId ? previous.sessionId : sourceSessionId;
		const held = await manifest(target);
		const oldEntries = held ? await heldEntries(held) : [];
		let cursor = 0;
		for (const record of entries) {
			if (isDeepStrictEqual(record.value, oldEntries[cursor])) cursor++;
		}
		const extendsHeld = cursor === oldEntries.length;
		const writerKind = marker?.size === stamp.size && marker.mtimeMs === stamp.mtimeMs ? "hatch" : "other";
		const fork = held !== undefined && !extendsHeld && writerKind === "hatch";
		const sessionId = fork ? store.mintId() : target;
		const divergence: Divergence | null = fork
			? {
					kind: "k9f2",
					parentSessionId: target,
					note: "Imported a developer-hatch history that diverged from its original session.",
				}
			: (held?.divergence ?? null);
		const next: SessionManifest = {
			id: sessionId,
			header: { ...header.value, id: sessionId },
			entryIds: entries.map((record) => record.key),
			divergence,
		};
		const nextLedger: JsonlImportLedger = {
			...stamp,
			path,
			sourceSessionId,
			sessionId,
			highWaterMark: highWaterMark(entries.at(-1) ?? header),
			writerKind,
			checkedAt: now(),
		};
		const writes: StoreWrite[] = [];
		const oldByKey = new Map(held?.entryIds.map((key, index) => [key, oldEntries[index]]));
		const nextIds = new Set(next.entryIds);
		if (held && !fork) {
			for (const id of held.entryIds) {
				if (!nextIds.has(id)) writes.push({ op: "delete", key: entryKey(sessionId, id) });
			}
		}
		let imported = 0;
		for (const record of entries) {
			if (!fork && isDeepStrictEqual(record.value, oldByKey.get(record.key))) continue;
			writes.push({ op: "put", key: entryKey(sessionId, record.key), data: record.stored });
			imported++;
		}
		writes.push(
			{ op: "put", key: sessionKey(sessionId), data: next },
			{ op: "put", key: ledgerKey(path), data: nextLedger },
		);
		await commit(writes);
		return {
			outcome: !held ? "imported" : fork ? "forked" : extendsHeld ? "extended" : "adopted",
			sessionId,
			imported,
		};
	};

	return {
		open: (paths: readonly string[]) =>
			admission.admit(async () => {
				const results: JsonlImportResult[] = [];
				for (const path of paths) results.push(await importFile(resolve(path)));
				return results;
			}),
		importFile: (path: string) => admission.admit(() => importFile(resolve(path))),
		getLedger: (path: string) => ledger(resolve(path)),
		getSession: (id: string) =>
			admission.admit(async () => {
				const held = await manifest(id);
				if (!held) return undefined;
				return {
					id: held.id,
					header: held.header,
					entries: await heldEntries(held),
					divergence: held.divergence ?? undefined,
				};
			}),
		/**
		 * Record only the snapshot S20 wrote, never bytes an interleaving writer added afterward. S20 must pass a
		 * captured stamp and the exact written image, under its projection admission (do not nest admissions).
		 */
		async recordProjection(path: string, contents: string, written: JsonlFileStamp): Promise<void> {
			path = resolve(path);
			const bytes = Buffer.from(contents);
			if (bytes.length !== written.size) throw new Error("Projection size does not match its written image");
			const { header, entries } = parse(bytes);
			const held = await manifest(header.value.id);
			if (
				!held ||
				!isDeepStrictEqual(
					await heldEntries(held),
					entries.map((record) => record.value),
				)
			) {
				throw new Error("Projection does not match the committed session");
			}
			const record: JsonlImportLedger = {
				...written,
				path,
				sourceSessionId: header.value.id,
				sessionId: held.id,
				highWaterMark: highWaterMark(entries.at(-1) ?? header),
				writerKind: "store",
				checkedAt: now(),
			};
			await commit([{ op: "put", key: ledgerKey(path), data: record }]);
		},
	};
}
