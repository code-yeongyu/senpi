import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { DurableStore, StoreValue, StoreWrite } from "@earendil-works/pi-agent-core/conformance";

export type JsonlFileStamp = { size: number; mtimeMs: number; ctimeMs: number };
type HatchMarker = { size: number; mtimeMs: number };
type JsonlRecord = { [key: string]: StoreValue; type: string; id: string };
type LocatedRecord = { value: JsonlRecord; raw: string; offset: number; end: number };
type HighWaterMark = { id: string; hash: string; offset: number; end: number };
type Divergence = { kind: "k9f2"; parentSessionId: string; note: string };
type SessionManifest = {
	id: string;
	header: JsonlRecord;
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

function parse(bytes: Uint8Array): { header: LocatedRecord; entries: LocatedRecord[] } {
	const records: LocatedRecord[] = [];
	let offset = 0;
	for (let end = 0; end <= bytes.length; end++) {
		if (end !== bytes.length && bytes[end] !== 10) continue;
		const raw = Buffer.from(bytes.subarray(offset, end)).toString("utf8");
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			offset = end + 1;
			continue; // The legacy reader also skips blank and torn/malformed lines.
		}
		if (
			typeof value !== "object" ||
			value === null ||
			!("type" in value) ||
			typeof value.type !== "string" ||
			!("id" in value) ||
			typeof value.id !== "string"
		)
			throw new Error("Invalid JSONL session record");
		records.push({ value: value as JsonlRecord, raw, offset, end });
		offset = end + 1;
	}
	const [header, ...entries] = records;
	if (!header || header.value.type !== "session") throw new Error("JSONL session has no header");
	const ids = new Set<string>();
	for (const record of entries) {
		if (record.value.type === "session" || ids.has(record.value.id)) throw new Error("Duplicate JSONL session entry");
		ids.add(record.value.id);
	}
	return { header, entries };
}

const highWaterMark = (record: LocatedRecord): HighWaterMark => ({
	id: record.value.id,
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
	const heldEntries = async (held: SessionManifest): Promise<JsonlRecord[]> =>
		Promise.all(
			held.entryIds.map(async (id) => {
				const raw = await store.getDocument(entryKey(held.id, id));
				if (typeof raw !== "string") throw new Error(`Missing imported session entry ${id}`);
				return JSON.parse(raw) as JsonlRecord;
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
			entryIds: entries.map((record) => record.value.id),
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
		const oldById = new Map(oldEntries.map((record) => [record.id, record]));
		const nextIds = new Set(next.entryIds);
		if (held && !fork) {
			for (const id of held.entryIds) {
				if (!nextIds.has(id)) writes.push({ op: "delete", key: entryKey(sessionId, id) });
			}
		}
		let imported = 0;
		for (const record of entries) {
			if (!fork && isDeepStrictEqual(record.value, oldById.get(record.value.id))) continue;
			writes.push({ op: "put", key: entryKey(sessionId, record.value.id), data: record.raw });
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
