import { randomUUID } from "node:crypto";
import { open, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
	createAdmissionLine,
	openSessionStore,
	openSyncSessionStore,
	type SessionHeader,
	type StoredEntry,
	type SyncCommitStore,
	type SyncSessionHandle,
} from "@earendil-works/pi-agent-core";
import type { StoreValue } from "@earendil-works/pi-agent-core/conformance";
import { captureFileIdentity } from "../session-file-identity.ts";
import { createJsonlImporter, type JsonlFileStamp } from "../session-import/jsonl-import.ts";
import type { FileIdentity } from "../session-transcript-journal.ts";

/** The binding's asynchronous whole-file projection writes; the default is the atomic replace below. A test seam for win32. */
export interface ProjectionFiles {
	replace(path: string, contents: string): Promise<void>;
}

export interface DurableStoreBinding {
	readonly store: SyncCommitStore;
	readonly epoch: number;
	readonly files?: ProjectionFiles;
}

/** SessionManager's write discipline for the binding's own file writes (repair, reprojection on open). */
export interface ProjectionHooks {
	/** Throws when this manager may no longer write the file (fenced, moved): the write does not happen. */
	beforeWrite(path: string): void;
	/** The file was replaced: its identity changed. */
	afterReplace(path: string, identity: FileIdentity | undefined): void;
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

/** Today's atomic replace, asynchronous: a temp file written and synced beside the target, then renamed over it. */
async function replaceAtomically(path: string, contents: string): Promise<FileIdentity | undefined> {
	const mode = (await modeOf(path)) ?? 0o600;
	const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
	const handle = await open(temp, "wx", mode);
	let identity: FileIdentity | undefined;
	try {
		await handle.writeFile(contents);
		await handle.sync();
		identity = await captureFileIdentity(handle.fd, path);
	} finally {
		await handle.close();
	}
	try {
		await rename(temp, path);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
	return identity;
}

async function modeOf(path: string): Promise<number | undefined> {
	try {
		return (await stat(path)).mode & 0o777;
	} catch (error) {
		if (codeOf(error) === "ENOENT") return undefined;
		throw error;
	}
}

const isRecord = (value: StoreValue | undefined): value is { readonly [key: string]: StoreValue } =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const staleSessionIdOf = (mark: StoreValue | undefined): string | undefined =>
	isRecord(mark) && typeof mark.sessionId === "string" ? mark.sessionId : undefined;

/** A provided ProjectionFiles is called as a method, so a class implementing it keeps its `this`; its identity is unknown. */
async function replaceWith(
	files: ProjectionFiles | undefined,
	path: string,
	contents: string,
): Promise<FileIdentity | undefined> {
	if (files === undefined) return replaceAtomically(path, contents);
	await files.replace(path, contents);
	return undefined;
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
	// Projected appends not yet in the ledger, in file order. A later append's record carries them, so a burst of appends
	// keeps the ledger's prefix chain even though only the last one's record runs.
	private unrecordedTails: { readonly key: string; readonly line: string; readonly offset: number }[] = [];
	// A whole-file write whose ledger record a later append superseded: the chain has no start until a record covers the
	// whole file, so the next record writes today's whole image instead of the tails.
	private wholeUnrecorded = false;

	private readonly binding: DurableStoreBinding;
	private readonly handle: SyncSessionHandle;
	private readonly importer: Importer;
	private readonly admission: ReturnType<typeof createAdmissionLine>;
	private readonly warn: Warn;
	private readonly hooks: ProjectionHooks;

	private constructor(
		binding: DurableStoreBinding,
		handle: SyncSessionHandle,
		importer: Importer,
		admission: ReturnType<typeof createAdmissionLine>,
		warn: Warn,
		hooks: ProjectionHooks,
		projectedSize: number,
	) {
		this.binding = binding;
		this.handle = handle;
		this.importer = importer;
		this.admission = admission;
		this.warn = warn;
		this.hooks = hooks;
		this.projectedSize = projectedSize;
	}

	static async open(
		binding: DurableStoreBinding,
		sessionFile: string,
		sessionId: string,
		headerLine: string,
		warn: Warn,
		hooks: ProjectionHooks,
	): Promise<{ readonly session: DurableSessionBinding; readonly reprojected: boolean }> {
		const { store, epoch } = binding;
		const path = resolve(sessionFile);
		const admission = createAdmissionLine();
		const importer = createJsonlImporter({ store, epoch, admission });
		let id = sessionId;
		let reprojected = false;
		if ((await stampOf(path)) !== undefined) {
			const mark = await store.getDocument(staleKey(path));
			const markedId = staleSessionIdOf(mark);
			if (markedId !== undefined) {
				const stored = await openSessionStore(store, epoch).load(markedId);
				if (stored === undefined) throw new Error(`the store marks ${path} stale but holds no session ${markedId}`);
				await reprojectFile(
					importer,
					admission,
					binding,
					hooks,
					path,
					projectionImage(stored.header, stored.entries),
				);
				id = markedId;
				reprojected = true;
			} else {
				id = (await importer.importFile(path)).sessionId;
			}
		}
		const handle = await openSyncSessionStore(store, epoch).open(id, JSON.parse(headerLine) as SessionHeader);
		const size = (await stampOf(path))?.size ?? 0;
		return {
			session: new DurableSessionBinding(binding, handle, importer, admission, warn, hooks, size),
			reprojected,
		};
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
		const offset = this.projectedSize;
		this.projectedSize += Buffer.byteLength(entry.line) + 1;
		const sessionId = String(this.handle.header().id);
		this.unrecordedTails.push({ key: entry.key, line: entry.line, offset });
		this.record(path, async () => {
			const tails = [...this.unrecordedTails];
			const whole = this.wholeUnrecorded ? projectionImage(this.handle.header(), this.handle.entries()) : undefined;
			const written = await stampOf(path);
			if (written === undefined) return;
			if (whole === undefined) await this.importer.recordProjectedTail(path, sessionId, tails, written);
			else await this.importer.recordProjection(path, whole, written);
			this.unrecordedTails.splice(0, tails.length);
			if (whole !== undefined) this.wholeUnrecorded = false;
		});
	}

	/** The caller wrote the whole file from today's serializer: record that image, unless a later write supersedes it. */
	recordWhole(sessionFile: string): void {
		const path = resolve(sessionFile);
		const contents = projectionImage(this.handle.header(), this.handle.entries());
		this.projectedSize = Buffer.byteLength(contents);
		this.unrecordedTails = [];
		this.wholeUnrecorded = true;
		this.record(path, async () => {
			const written = await stampOf(path);
			if (written === undefined) return;
			await this.importer.recordProjection(path, contents, written);
			this.wholeUnrecorded = false;
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

	/** The file no longer matches the store (it was rewritten from an older image): mark it stale and reproject. */
	markProjectionStale(sessionFile: string): void {
		const path = resolve(sessionFile);
		if (!this.stale) {
			const data = { sessionId: String(this.handle.header().id) };
			this.binding.store.commitSync(this.binding.epoch, [{ op: "put", key: staleKey(path), data }], () => {});
			this.stale = true;
		}
		this.scheduleRepair(path);
	}

	/** Settles once any scheduled reprojection and ledger record has run (tests and orderly shutdown). */
	settled(): Promise<void> {
		return this.admission.admit(async () => {});
	}

	// One repair per stale write, serialized on the admission line and fully asynchronous. A repair that a later write
	// overtook keeps the mark and runs again; one that fails warns, so a persistent failure is reported on each write.
	scheduleRepair(sessionFile: string): void {
		const path = resolve(sessionFile);
		void this.admission
			.admit(async () => {
				if (!this.stale) return;
				const generation = this.generation;
				const contents = projectionImage(this.handle.header(), this.handle.entries());
				this.hooks.beforeWrite(path);
				this.hooks.afterReplace(path, await replaceWith(this.binding.files, path, contents));
				if (generation !== this.generation) return this.scheduleRepair(path);
				this.binding.store.commitSync(this.binding.epoch, [{ op: "delete", key: staleKey(path) }], () => {});
				this.stale = false;
				this.projectedSize = Buffer.byteLength(contents);
				this.unrecordedTails = [];
				this.wholeUnrecorded = false;
				const written = await stampOf(path);
				if (written !== undefined && generation === this.generation) {
					await this.importer.recordProjection(path, contents, written);
				}
			})
			.catch((error: unknown) => this.projectionFailed(path, error));
	}

	// A ledger record a later write superseded (it committed while this one awaited) is dropped, not reported: the later
	// write records its own projection, or marks the projection stale.
	private record(path: string, write: () => Promise<void>): void {
		const generation = this.generation;
		void this.admission
			.admit(async () => {
				if (generation === this.generation) await write();
			})
			.catch((error: unknown) => {
				if (generation !== this.generation) return;
				this.warn({ path, code: codeOf(error), message: `projection ledger not recorded: ${messageOf(error)}` });
			});
	}
}

async function reprojectFile(
	importer: Importer,
	admission: ReturnType<typeof createAdmissionLine>,
	binding: DurableStoreBinding,
	hooks: ProjectionHooks,
	path: string,
	contents: string,
): Promise<void> {
	hooks.beforeWrite(path);
	hooks.afterReplace(path, await replaceWith(binding.files, path, contents));
	const written = await stampOf(path);
	if (written !== undefined) await admission.admit(() => importer.recordProjection(path, contents, written));
	binding.store.commitSync(binding.epoch, [{ op: "delete", key: staleKey(path) }], () => {});
}
