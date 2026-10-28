import { createHash } from "node:crypto";
import type { FileEntry } from "../../core/session-manager.ts";
import {
	type PersistedBase,
	type PersistedBaseError,
	readPersistedBase,
	type TranscriptTransition,
	type TranscriptUnavailableReason,
	type TranscriptPersistence,
} from "../../core/session-transcript-journal.ts";

/** One worker frame's worth of unwritten entries; persisted history consumes no content budget. */
export const DEFAULT_TRANSCRIPT_TAIL_BYTES = 16 * 1024 * 1024;
/**
 * What an epoch keeps of every accepted entry after persistence released its text: its id, kind and parent link
 * (RULING-61 Q1 = C). Each record is charged no less than the heap it holds, so this budget bounds the retained heap
 * itself, and the record count to at most 8 MiB / 40 B = 209,715 (records of empty strings).
 */
export const DEFAULT_TRANSCRIPT_ANCESTRY_BYTES = 8 * 1024 * 1024;
/** Three 8-byte array slots (id, kind, parent), plus the half more a growing array may hold unused: 36, to 40. */
const ANCESTRY_RECORD_BYTES = 40;
/** A distinct kind's row in the epoch's kind table: key, value, chain and bucket slots, doubled for table growth. */
const KIND_NAME_BYTES = 64;

/** A string's heap: a 16-byte header and its code units (one byte each when all are ASCII, else two), 8-aligned. */
const stringBytes = (value: string): number =>
	value === ""
		? 0
		: Math.ceil((16 + (Buffer.byteLength(value) === value.length ? value.length : 2 * value.length)) / 8) * 8;

/** One accepted entry of the epoch, at its accepted index, as a frozen root names it. */
export interface AcceptedEntry {
	readonly index: number;
	readonly id: string;
	readonly kind: string;
	readonly parentId: string | null;
}

/**
 * The first `count` entries of an epoch's columns. The lane only appends to its columns (a `replace` starts new ones),
 * so this prefix never changes: a root freezes in O(1) without a copy and never sees an entry accepted after it.
 */
export class AcceptedEntries implements Iterable<AcceptedEntry> {
	private readonly ids: readonly string[];
	private readonly kinds: readonly string[];
	private readonly parents: readonly (string | null)[];
	readonly count: number;

	constructor(ids: readonly string[], kinds: readonly string[], parents: readonly (string | null)[], count: number) {
		this.ids = ids;
		this.kinds = kinds;
		this.parents = parents;
		this.count = count;
	}

	/** The ids of the first `end` entries, as the base reader takes them. */
	idsBefore(end: number): string[] {
		return this.ids.slice(0, Math.min(end, this.count));
	}

	*[Symbol.iterator](): Generator<AcceptedEntry> {
		for (let index = 0; index < this.count; index++)
			yield { index, id: this.ids[index], kind: this.kinds[index], parentId: this.parents[index] };
	}
}

interface TranscriptTail {
	readonly entries: Map<number, string>;
	retainedBytes: number;
	persistence: TranscriptPersistence | null;
}

/**
 * A cut names its base and accepted ids. Its shared tail releases content only once the captured file covers it;
 * persistence may change the source of those exact entries, never the accepted count.
 */
export interface TranscriptRoot {
	readonly historyVersion: number;
	readonly leafId: string | null;
	readonly base: PersistedBase | null;
	/** Exactly the `count` entries accepted when the root froze: id, engine kind and parent link. */
	readonly accepted: AcceptedEntries;
	readonly ancestryBytes: number;
	readonly tail: TranscriptTail;
	readonly count: number;
	readonly unavailable: TranscriptUnavailableReason | null;
}

export type TranscriptRead =
	| { readonly ok: true; readonly entries: readonly FileEntry[] }
	| { readonly ok: false; readonly error: PersistedBaseError | TranscriptUnavailableReason };

/** The transcript component of one epoch, changed only by accepted transitions (R3.C1.1). */
export class AcceptedTranscript {
	private version = 0;
	private leafId: string | null = null;
	private base: PersistedBase | null = null;
	private entryIds: string[] = [];
	private kinds: string[] = [];
	private parents: (string | null)[] = [];
	/** Each distinct kind once per epoch, so every record of a kind shares one string whatever the producer sent. */
	private kindNames = new Map<string, string>();
	private ancestryBytes = 0;
	private tail: TranscriptTail = { entries: new Map(), retainedBytes: 0, persistence: null };
	private unavailable: TranscriptUnavailableReason | null = null;

	get historyVersion(): number {
		return this.version;
	}

	get available(): boolean {
		return this.unavailable === null;
	}

	apply(transition: TranscriptTransition): void {
		this.version += 1;
		if (transition.kind === "replace") {
			this.base = transition.base;
			this.entryIds = [];
			this.kinds = [];
			this.parents = [];
			this.kindNames = new Map();
			this.ancestryBytes = 0;
			this.tail = {
				entries: new Map(),
				retainedBytes: 0,
				persistence: transition.base,
			};
			this.unavailable = null;
			return;
		}
		if (transition.kind === "unavailable") {
			this.markUnavailable(transition.reason);
			return;
		}
		if (transition.kind === "persisted") {
			this.persisted(transition.persistence);
			return;
		}
		if (this.unavailable !== null) return;
		if (transition.kind === "append") {
			const index = this.entryIds.length;
			if (!this.retainAncestry(transition.id, transition.type, transition.parentId)) return;
			if (transition.persistence) this.persisted(transition.persistence);
			if (index + (this.base?.count ?? 0) >= (this.tail.persistence?.count ?? 0)) {
				const bytes = Buffer.byteLength(transition.entry ?? "");
				if (this.tail.retainedBytes + bytes > DEFAULT_TRANSCRIPT_TAIL_BYTES) {
					this.markUnavailable("transcript_tail_over_byte_limit");
					return;
				}
				if (transition.entry !== undefined) {
					this.tail.entries.set(index, transition.entry);
					this.tail.retainedBytes += bytes;
				}
			}
			this.leafId = transition.id;
		} else this.leafId = transition.leafId;
	}

	/**
	 * Charges what the record really holds: its slots, its id, a kind the epoch has not seen, and a parent link unless it
	 * shares the previous entry's own id string (the common chain).
	 */
	private retainAncestry(id: string, type: string, parentId: string | null): boolean {
		const previous = this.entryIds.at(-1);
		const shared = previous !== undefined && previous === parentId;
		const kind = this.kindNames.get(type);
		const bytes =
			ANCESTRY_RECORD_BYTES +
			stringBytes(id) +
			(kind === undefined ? KIND_NAME_BYTES + stringBytes(type) : 0) +
			(shared ? 0 : stringBytes(parentId ?? ""));
		if (this.ancestryBytes + bytes > DEFAULT_TRANSCRIPT_ANCESTRY_BYTES) {
			this.markUnavailable("transcript_ancestry_over_byte_limit");
			return false;
		}
		if (kind === undefined) this.kindNames.set(type, type);
		this.entryIds.push(id);
		this.kinds.push(kind ?? type);
		this.parents.push(shared ? previous : parentId);
		this.ancestryBytes += bytes;
		return true;
	}

	private markUnavailable(reason: TranscriptUnavailableReason): void {
		this.unavailable ??= reason;
		process.stderr.write(`senpi rpc acceptance: transcript component unavailable: ${reason}\n`);
	}

	freeze(): TranscriptRoot {
		return Object.freeze({
			historyVersion: this.version,
			leafId: this.leafId,
			base: this.base,
			accepted: new AcceptedEntries(this.entryIds, this.kinds, this.parents, this.entryIds.length),
			ancestryBytes: this.ancestryBytes,
			tail: this.tail,
			count: this.entryIds.length,
			unavailable: this.unavailable,
		});
	}

	private persisted(persistence: TranscriptPersistence): void {
		this.tail.persistence = persistence;
		for (const [index, entry] of this.tail.entries) {
			if (index + (this.base?.count ?? 0) >= persistence.count) break;
			this.tail.retainedBytes -= Buffer.byteLength(entry);
			this.tail.entries.delete(index);
		}
	}
}

/** The root's entries: its base read only through the captured identity, then its own accepted values. */
export function readTranscriptRoot(root: TranscriptRoot): TranscriptRead {
	if (root.unavailable !== null) return { ok: false, error: root.unavailable };
	const persistence = root.tail.persistence;
	const persistedCount = Math.min(root.count, Math.max(0, (persistence?.count ?? 0) - (root.base?.count ?? 0)));
	const base =
		root.base ??
		(persistence && {
			fileIdentity: persistence.fileIdentity,
			count: 0,
			idFingerprint: createHash("sha256").digest("hex"),
		});
	const persisted = base
		? readPersistedBase(base, root.accepted.idsBefore(persistedCount))
		: { ok: true as const, entries: [] };
	if (!persisted.ok) return persisted;
	const entries = [...persisted.entries];
	for (let index = persistedCount; index < root.count; index++) {
		const entry = root.tail.entries.get(index);
		if (entry === undefined) return { ok: false, error: "transcript_tail_trimmed" };
		entries.push(JSON.parse(entry) as FileEntry);
	}
	return { ok: true, entries };
}
