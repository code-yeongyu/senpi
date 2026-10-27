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
	readonly entryIds: readonly string[];
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
			this.entryIds.push(transition.id);
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

	private markUnavailable(reason: TranscriptUnavailableReason): void {
		this.unavailable ??= reason;
		process.stderr.write(`senpi rpc acceptance: transcript component unavailable: ${reason}\n`);
	}

	freeze(): TranscriptRoot {
		return Object.freeze({
			historyVersion: this.version,
			leafId: this.leafId,
			base: this.base,
			entryIds: this.entryIds,
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
		? readPersistedBase(base, root.entryIds.slice(0, persistedCount))
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
