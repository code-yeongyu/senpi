import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { DurableStore, StoreValue, StoreWrite } from "@earendil-works/pi-agent-core/conformance";
import {
	appendRecordWrites,
	divergenceWrite,
	manifestWrite,
	readSessionState,
	rewriteRecordWrite,
	type SessionState,
} from "@earendil-works/pi-agent-core";
import { type FileEntry, migrateSessionEntries } from "../session-manager.ts";

export type JsonlFileStamp = { size: number; mtimeMs: number; ctimeMs: number };
type HatchMarker = { size: number; mtimeMs: number };
type JsonlObject = { [key: string]: StoreValue };
type JsonlHeader = JsonlObject & { type: "session"; id: string };
/** `key` names the entry in the store; `stored` is what is written there (the migrated JSON for a legacy file). */
type LocatedRecord = { value: StoreValue; key: string; stored: string; raw: string; offset: number; end: number };
type HighWaterMark = { id: string; hash: string; offset: number; end: number };

/** The file's lines from its header through the high-water mark, chained: an edit or removal anywhere before it differs. */
const PREFIX_DOMAIN = "senpi-jsonl-prefix/1";
const chainLine = (previous: string, raw: string): string =>
	createHash("sha256").update(previous).update("\u0000").update(raw).digest("hex");
const chainOf = (raws: readonly string[]): string[] => {
	const digests: string[] = [];
	let digest = createHash("sha256").update(PREFIX_DOMAIN).digest("hex");
	for (const raw of raws) {
		digest = chainLine(digest, raw);
		digests.push(digest);
	}
	return digests;
};
type Divergence = { kind: "k9f2"; parentSessionId: string; note: string };

/** The stored divergence marker, or null for anything that is not one. */
const isStoreRecord = (value: StoreValue): value is { readonly [key: string]: StoreValue } =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function divergenceOf(value: StoreValue): Divergence | null {
	if (!isStoreRecord(value)) return null;
	return value.kind === "k9f2" && typeof value.parentSessionId === "string" && typeof value.note === "string"
		? { kind: "k9f2", parentSessionId: value.parentSessionId, note: value.note }
		: null;
}

export type JsonlImportLedger = JsonlFileStamp & {
	path: string;
	sourceSessionId: string;
	sessionId: string;
	highWaterMark: HighWaterMark;
	/** The chained digest of every line through the high-water mark; absent in ledgers written before it existed. */
	prefixDigest?: string;
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

const LEDGER = "session-import/file/";
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
	const manifest = (id: string): Promise<SessionState | undefined> => readSessionState(store, id);
	const ledger = async (path: string) => (await store.getDocument(ledgerKey(path))) as JsonlImportLedger | undefined;
	const heldEntries = (held: SessionState): StoreValue[] =>
		held.entries.map((entry) => JSON.parse(entry.line) as StoreValue);
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
		const lines = [header, ...entries];
		const digests = chainOf(lines.map((line) => line.raw));
		// A file that only grew past what it last held: its lines through the high-water mark are byte-for-byte unchanged,
		// so every later line is new and is appended beside whatever co-bound writers appended meanwhile.
		const markIndex =
			held !== undefined && previous?.sessionId === target && previous.prefixDigest !== undefined
				? lines.findIndex(
						(line, index) => line.key === previous.highWaterMark.id && digests[index] === previous.prefixDigest,
					)
				: -1;
		if (held !== undefined && markIndex >= 0) {
			const heldKeys = new Set(held.entries.map((entry) => entry.key));
			const fresh = entries.slice(markIndex).filter((record) => !heldKeys.has(record.key));
			const grown: JsonlImportLedger = {
				...stamp,
				path,
				sourceSessionId,
				sessionId: target,
				highWaterMark: highWaterMark(lines.at(-1) ?? header),
				prefixDigest: digests.at(-1),
				writerKind: marker?.size === stamp.size && marker.mtimeMs === stamp.mtimeMs ? "hatch" : "other",
				checkedAt: now(),
			};
			await commit([
				...appendRecordWrites(
					target,
					held.rewrites,
					fresh.map((record) => ({ key: record.key, line: record.stored })),
				),
				{ op: "put", key: ledgerKey(path), data: grown },
			]);
			return { outcome: "extended", sessionId: target, imported: fresh.length };
		}
		const oldEntries = held ? heldEntries(held) : [];
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
			: divergenceOf(held?.divergence ?? null);
		const nextHeader: StoreValue = { ...header.value, id: sessionId };
		const nextLedger: JsonlImportLedger = {
			...stamp,
			path,
			sourceSessionId,
			sessionId,
			highWaterMark: highWaterMark(entries.at(-1) ?? header),
			prefixDigest: digests.at(-1),
			writerKind,
			checkedAt: now(),
		};
		const oldByKey = new Map(held?.entries.map((entry, index) => [entry.key, oldEntries[index]]));
		let imported = 0;
		for (const record of entries) {
			if (fork || !isDeepStrictEqual(record.value, oldByKey.get(record.key))) imported++;
		}
		const stored = entries.map((record) => ({ key: record.key, line: record.stored }));
		// A file that only adds entries after the held ones is appended as records, so it never overwrites an entry a
		// co-bound writer appended meanwhile; any other change rewrites the session from the file, as S07 rules.
		const prefix =
			held !== undefined &&
			!fork &&
			entries.length >= oldEntries.length &&
			oldEntries.every((value, index) => isDeepStrictEqual(entries[index]?.value, value)) &&
			isDeepStrictEqual(nextHeader, held.header) &&
			isDeepStrictEqual(divergence, held.divergence);
		const writes: StoreWrite[] = prefix
			? appendRecordWrites(sessionId, held?.rewrites ?? 0, stored.slice(oldEntries.length))
			: [
					manifestWrite(sessionId, nextHeader),
					divergenceWrite(sessionId, divergence),
					rewriteRecordWrite(store, sessionId, nextHeader, stored),
				];
		writes.push({ op: "put", key: ledgerKey(path), data: nextLedger });
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
					entries: heldEntries(held),
					divergence: divergenceOf(held.divergence) ?? undefined,
				};
			}),
		/**
		 * Record an append the store projected: only the bytes it wrote, so a file that grew by more keeps the extra bytes
		 * unrecorded for the next import. O(1): the appended line is the new high-water mark, nothing is re-parsed.
		 */
		async recordProjectedTail(
			path: string,
			sessionId: string,
			tail: { readonly key: string; readonly line: string; readonly offset: number },
			written: JsonlFileStamp,
		): Promise<void> {
			path = resolve(path);
			const end = tail.offset + Buffer.byteLength(tail.line);
			// The file must end exactly at this append (+ its newline): bytes another writer added are never recorded.
			if (written.size !== end + 1) throw new Error("Projection size does not match its written image");
			const previous = await ledger(path);
			// The chain extends only across an append that directly follows the recorded high-water mark.
			const prefixDigest =
				previous?.prefixDigest !== undefined && previous.highWaterMark.end + 1 === tail.offset
					? chainLine(previous.prefixDigest, tail.line)
					: undefined;
			const record: JsonlImportLedger = {
				...written,
				path,
				sourceSessionId: sessionId,
				sessionId,
				highWaterMark: { id: tail.key, hash: hash(tail.line), offset: tail.offset, end },
				...(prefixDigest === undefined ? {} : { prefixDigest }),
				writerKind: "store",
				checkedAt: now(),
			};
			await commit([{ op: "put", key: ledgerKey(path), data: record }]);
		},
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
					heldEntries(held),
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
				prefixDigest: chainOf([header.raw, ...entries.map((record) => record.raw)]).at(-1),
				writerKind: "store",
				checkedAt: now(),
			};
			await commit([{ op: "put", key: ledgerKey(path), data: record }]);
		},
	};
}
