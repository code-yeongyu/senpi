import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
	createAdmissionLine,
	openSessionStore,
	openSyncSessionStore,
	type SessionHeader,
	type StoredEntry,
	type SyncCommitStore,
	type SyncSessionHandle,
} from "@earendil-works/pi-agent-core";
import { replaceFileAtomically } from "../session-file-replace.ts";
import { createJsonlImporter, type JsonlFileStamp } from "../session-import/jsonl-import.ts";

export interface DurableStoreBinding {
	readonly store: SyncCommitStore;
	readonly epoch: number;
}

export interface ProjectionWarning {
	readonly path: string;
	readonly code: string;
	readonly message: string;
}

/** The S07 importer's key rule: an entry id that starts with `~` gets one more, so it cannot equal a positional key. */
export const storeKeyOf = (entryId: string): string => (entryId.startsWith("~") ? `~${entryId}` : entryId);

const STALE = "session-store/projection-stale/";
const staleKey = (path: string): string => STALE + encodeURIComponent(path);

const codeOf = (error: unknown): string =>
	error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "unknown";
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function projectionImage(header: SessionHeader, entries: readonly StoredEntry[]): string {
	return [JSON.stringify(header), ...entries.map((entry) => entry.line)].map((line) => `${line}\n`).join("");
}

async function stampOf(path: string): Promise<JsonlFileStamp | undefined> {
	try {
		const value = await stat(path);
		return { size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs };
	} catch (error) {
		if (codeOf(error) === "ENOENT") return undefined;
		throw error;
	}
}

type Importer = ReturnType<typeof createJsonlImporter>;
type Warn = (warning: ProjectionWarning) => void;

/**
 * A SessionManager's binding to the durable store (S20b). Every write commits to the store first; the JSONL is its
 * projection. A projection write that fails after the commit never throws (the store took the entry): it commits a
 * durable stale mark, warns once per failed write, and the JSONL is rewritten from the store off the caller's call.
 * The binding adds no synchronous filesystem call to the session path: stamps and reprojection run on its admission
 * line.
 */
export class DurableSessionBinding {
	private stale = false;
	private projectedSize: number;
	// Bumped by every store commit: a deferred whole-image ledger record is skipped once a later write superseded it.
	private generation = 0;

	private constructor(
		private readonly binding: DurableStoreBinding,
		private readonly handle: SyncSessionHandle,
		private readonly importer: Importer,
		private readonly admission: ReturnType<typeof createAdmissionLine>,
		private readonly warn: Warn,
		projectedSize: number,
	) {
		this.projectedSize = projectedSize;
	}

	static async open(
		binding: DurableStoreBinding,
		sessionFile: string,
		sessionId: string,
		headerLine: string,
		warn: Warn,
	): Promise<{ readonly session: DurableSessionBinding; readonly reprojected: boolean }> {
		const { store, epoch } = binding;
		const path = resolve(sessionFile);
		const admission = createAdmissionLine();
		const importer = createJsonlImporter({ store, epoch, admission });
		let id = sessionId;
		let reprojected = false;
		if ((await stampOf(path)) !== undefined) {
			const mark = await store.getDocument(staleKey(path));
			const markedId =
				typeof mark === "object" && mark !== null && !Array.isArray(mark) && typeof mark.sessionId === "string"
					? mark.sessionId
					: undefined;
			if (markedId !== undefined) {
				const stored = await openSessionStore(store, epoch).load(markedId);
				if (stored === undefined) throw new Error(`the store marks ${path} stale but holds no session ${markedId}`);
				await reprojectFile(importer, admission, binding, path, projectionImage(stored.header, stored.entries));
				id = markedId;
				reprojected = true;
			} else {
				id = (await importer.importFile(path)).sessionId;
			}
		}
		const handle = await openSyncSessionStore(store, epoch).open(id, JSON.parse(headerLine) as SessionHeader);
		const size = (await stampOf(path))?.size ?? 0;
		return { session: new DurableSessionBinding(binding, handle, importer, admission, warn, size), reprojected };
	}

	/** Store first: a refusal throws here, on the caller's call, and nothing was taken. */
	commitAppend(entries: readonly StoredEntry[]): void {
		this.handle.appendSync(entries);
		this.generation++;
	}

	commitRewrite(headerLine: string, entries: readonly StoredEntry[]): void {
		this.handle.rewriteSync(JSON.parse(headerLine) as SessionHeader, entries);
		this.generation++;
	}

	/** While stale, the JSONL is not appended to: it is rewritten whole from the store. */
	projectionStale(): boolean {
		return this.stale;
	}

	/** The caller appended `entry`'s line to the file. The ledger records only those bytes, asynchronously. */
	projected(sessionFile: string, entry: StoredEntry): void {
		const path = resolve(sessionFile);
		if (this.stale) return this.scheduleReprojection(path);
		const offset = this.projectedSize;
		this.projectedSize += Buffer.byteLength(entry.line) + 1;
		const sessionId = String(this.handle.header().id);
		this.record(path, async () => {
			const written = await stampOf(path);
			if (written !== undefined)
				await this.importer.recordProjectedTail(path, sessionId, { ...entry, offset }, written);
		});
	}

	/** A whole-file projection (first flush, header, rewrite). Never throws. */
	projectWhole(sessionFile: string, write: () => void): void {
		const path = resolve(sessionFile);
		if (this.stale) return this.scheduleReprojection(path);
		try {
			write();
		} catch (error) {
			return this.projectionFailed(sessionFile, error);
		}
		const contents = projectionImage(this.handle.header(), this.handle.entries());
		this.projectedSize = Buffer.byteLength(contents);
		const generation = this.generation;
		this.record(path, async () => {
			if (generation !== this.generation) return;
			const written = await stampOf(path);
			if (written !== undefined) await this.importer.recordProjection(path, contents, written);
		});
	}

	/** Marks the projection stale in the store (durable, so a crash before the repair still reprojects on open). */
	projectionFailed(sessionFile: string, error: unknown): void {
		const path = resolve(sessionFile);
		let unmarked = "";
		if (!this.stale) {
			try {
				const data = { sessionId: String(this.handle.header().id) };
				this.binding.store.commitSync(this.binding.epoch, [{ op: "put", key: staleKey(path), data }], () => {});
			} catch (markError) {
				unmarked = `; the stale mark was not stored (${messageOf(markError)})`;
			}
			this.stale = true;
		}
		this.warn({ path, code: codeOf(error), message: `${messageOf(error)}${unmarked}` });
	}

	/** Settles once any scheduled reprojection and ledger record has run (tests and orderly shutdown). */
	settled(): Promise<void> {
		return this.admission.admit(async () => {});
	}

	// One repair per stale write, serialized on the admission line: a later one is a no-op once an earlier one succeeded,
	// and every one that fails warns, so a persistent failure is reported on each write.
	private scheduleReprojection(path: string): void {
		void this.admission
			.admit(async () => {
				if (!this.stale) return;
				const contents = projectionImage(this.handle.header(), this.handle.entries());
				replaceFileAtomically(path, [contents]);
				this.binding.store.commitSync(this.binding.epoch, [{ op: "delete", key: staleKey(path) }], () => {});
				this.stale = false;
				this.projectedSize = Buffer.byteLength(contents);
				const written = await stampOf(path);
				if (written !== undefined) await this.importer.recordProjection(path, contents, written);
			})
			.catch((error: unknown) => this.projectionFailed(path, error));
	}

	private record(path: string, write: () => Promise<void>): void {
		void this.admission.admit(write).catch((error: unknown) => {
			this.warn({ path, code: codeOf(error), message: `projection ledger not recorded: ${messageOf(error)}` });
		});
	}
}

async function reprojectFile(
	importer: Importer,
	admission: ReturnType<typeof createAdmissionLine>,
	binding: DurableStoreBinding,
	path: string,
	contents: string,
): Promise<void> {
	replaceFileAtomically(path, [contents]);
	const written = await stampOf(path);
	if (written !== undefined) await admission.admit(() => importer.recordProjection(path, contents, written));
	binding.store.commitSync(binding.epoch, [{ op: "delete", key: staleKey(path) }], () => {});
}
