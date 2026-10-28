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
import { stageBootstrap, TranscriptTail } from "./accepted-transcript-tail.ts";
import type { StagedContent, TransferStaging } from "./compact-transfer-staging.ts";

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
	private readonly staging: TransferStaging;
	private tail: TranscriptTail;
	private unavailable: TranscriptUnavailableReason | null = null;

	/** Entry texts are staged into, and spill through, the owning lane's staging store (S12a). */
	constructor(staging: TransferStaging) {
		this.staging = staging;
		this.tail = new TranscriptTail(staging, null);
	}

	get historyVersion(): number {
		return this.version;
	}

	get available(): boolean {
		return this.unavailable === null;
	}

	/**
	 * Applies a bootstrap whose entry texts the internal bootstrap reader staged first: a bootstrap refused at a bound
	 * leaves the epoch's transcript typed unavailable with nothing kept, never partial.
	 */
	bootstrap(transitions: readonly TranscriptTransition[]): void {
		const staged = stageBootstrap(this.staging, transitions);
		if (!staged) return this.markUnavailable("transcript_tail_over_byte_limit");
		try {
			for (const transition of transitions) this.apply(transition, staged.get(transition));
		} finally {
			for (const content of staged.values()) this.staging.abandon(content);
		}
	}

	/** `staged`: the append's entry text, already staged by the bootstrap reader; this transcript adopts it if kept. */
	apply(transition: TranscriptTransition, staged?: StagedContent): void {
		this.version += 1;
		if (transition.kind === "replace") {
			this.tail.releaseAll();
			this.base = transition.base;
			this.entryIds = [];
			this.kinds = [];
			this.parents = [];
			this.kindNames = new Map();
			this.ancestryBytes = 0;
			this.tail = new TranscriptTail(this.staging, transition.base);
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
			const unpersisted = index + (this.base?.count ?? 0) >= (this.tail.persistence?.count ?? 0);
			if (unpersisted && transition.entry !== undefined) {
				const content = staged ?? this.tail.stage(index, transition.entry);
				if (!content) {
					this.markUnavailable("transcript_tail_over_byte_limit");
					return;
				}
				this.tail.adopt(index, content);
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
		this.tail.persisted(persistence, this.base?.count ?? 0);
	}

	/** Releases the epoch's tail content once no root of it can be read any longer. */
	release(): void {
		this.tail.releaseAll();
	}
}

/**
 * The root's entries: its base read only through the captured identity, then its own accepted values from the tail,
 * held for the whole read so a persistence report during it cannot drop what it reads.
 */
export async function readTranscriptRoot(root: TranscriptRoot): Promise<TranscriptRead> {
	if (root.unavailable !== null) return { ok: false, error: root.unavailable };
	const hold = root.tail.hold(root.count, root.base?.count ?? 0);
	try {
		const persistence = hold.persistence;
		const base =
			root.base ??
			(persistence && {
				fileIdentity: persistence.fileIdentity,
				count: 0,
				idFingerprint: createHash("sha256").digest("hex"),
			});
		const persisted = base
			? readPersistedBase(base, root.accepted.idsBefore(hold.persistedCount))
			: { ok: true as const, entries: [] };
		if (!persisted.ok) return persisted;
		const entries = [...persisted.entries];
		for (let index = hold.persistedCount; index < root.count; index++) {
			if (!hold.has(index)) return { ok: false, error: "transcript_tail_trimmed" };
			let text = "";
			for await (const chunk of hold.chunks(index)) text += chunk;
			entries.push(JSON.parse(text) as FileEntry);
		}
		return { ok: true, entries };
	} finally {
		hold.release();
	}
}
