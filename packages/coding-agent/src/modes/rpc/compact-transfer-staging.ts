import { type CatalogEntry, catalogDigester, storedBytes } from "./compact-catalog-codec.ts";
import {
	COMPACT_LEAF_CODE_UNITS,
	type CompactContentStore,
	type CompactStorageStatus,
	type LeafId,
} from "./compact-content-store.ts";
import { CompactReadError } from "./compact-read-lease.ts";
import { FRAGMENT_MAX_BYTES, type FrozenBytes, openFrozenBytes } from "./compact-recovery-bytes.ts";
import type { BoundedId } from "./compact-recovery-ids.ts";

/**
 * The stored bytes one staging owner may hold staged and not yet adopted: B_worker (S12 design section 3), the host's
 * capacity for worker transfers. `begin` reserves a transfer's whole declared length before any leaf exists, so a
 * refusal allocates nothing; the bytes leave the bound when the content is adopted, released or aborted.
 */
export const TRANSFER_STAGING_MAX_BYTES = 64 * 1024 * 1024;
/** Code units one fragment carries: D (`FRAGMENT_MAX_BYTES`) stored bytes, two per UTF-16 code unit. */
const FRAGMENT_MAX_UNITS = FRAGMENT_MAX_BYTES / 2;

export type StagingRefusal = "staging_over_byte_limit" | "fragment_over_limit" | "length_mismatch" | "staging_closed";

export class TransferStagingError extends Error {
	readonly reason: StagingRefusal;

	constructor(reason: StagingRefusal) {
		super(`transfer staging refused (${reason})`);
		this.name = "TransferStagingError";
		this.reason = reason;
	}
}

/**
 * A frozen reference (RULING-46 item 2, RULING-63 Q2): content named by an S11a catalog entry, encoded only by that
 * codec (`CatalogNodeWriter` / `decodeCatalogNode`); `length` and `digest` are those of its exact stored UTF-16LE
 * bytes in the `leaf` domain. `staged` content lives in a host staging store; S13's lease variant extends this union
 * beside it and never reshapes it.
 */
export type FrozenRef = { readonly variant: "staged"; readonly entry: CatalogEntry };

/** Committed staged content: its frozen ref and the immutable leaves holding it, one live reference owned. */
export interface StagedContent {
	readonly ref: FrozenRef;
	readonly leaves: readonly LeafId[];
}

export interface StagingStatus extends CompactStorageStatus {
	readonly stagedBytes: number;
	readonly openTransfers: number;
}

/**
 * One logical value arriving in fragments (S12 design section 3): its stored length is declared up front, each
 * fragment becomes owned immutable leaves as it arrives, and nothing is visible until `commit`. A refusal aborts the
 * transfer and releases what it staged; `abort` is idempotent.
 */
class StagedTransfer {
	private readonly store: CompactContentStore;
	private readonly entry: Pick<CatalogEntry, "kind" | "id" | "length">;
	private readonly settle: (content: StagedContent | undefined) => void;
	private readonly digester: ReturnType<typeof catalogDigester>;
	private readonly leaves: LeafId[] = [];
	private fed = 0;
	private open = true;

	constructor(
		store: CompactContentStore,
		entry: Pick<CatalogEntry, "kind" | "id" | "length">,
		settle: (content: StagedContent | undefined) => void,
	) {
		this.store = store;
		this.entry = entry;
		this.settle = settle;
		this.digester = catalogDigester("leaf", entry.length);
	}

	append(text: string): void {
		this.assertOpen();
		const bytes = text.length * 2;
		if (bytes > FRAGMENT_MAX_BYTES) this.refuse("fragment_over_limit");
		if (this.fed + bytes > this.entry.length) this.refuse("length_mismatch");
		try {
			for (let at = 0; at < text.length; at += COMPACT_LEAF_CODE_UNITS)
				this.leaves.push(this.store.createLeaf(text.slice(at, at + COMPACT_LEAF_CODE_UNITS)));
		} catch (cause) {
			this.abort();
			throw cause;
		}
		this.digester.update(storedBytes(text));
		this.fed += bytes;
	}

	commit(): StagedContent {
		this.assertOpen();
		if (this.fed !== this.entry.length) this.refuse("length_mismatch");
		this.open = false;
		const content: StagedContent = {
			ref: { variant: "staged", entry: { ...this.entry, digest: this.digester.finish() } },
			leaves: [...this.leaves],
		};
		this.settle(content);
		return content;
	}

	abort(): void {
		if (!this.open) return;
		this.open = false;
		for (const leaf of this.leaves) this.store.adjust(leaf, -1, 0);
		this.settle(undefined);
	}

	private assertOpen(): void {
		if (!this.open) throw new TransferStagingError("staging_closed");
	}

	private refuse(reason: StagingRefusal): never {
		this.abort();
		throw new TransferStagingError(reason);
	}
}

/**
 * The shared bounded staging substrate (S12a; S12b's worker transfers and S13's leases reuse it): content is staged in
 * bounded fragments into one content store, which spills it like any payload leaf, and named by a `FrozenRef`. Staged
 * content stays unaccepted until its owner adopts it; `close` aborts every open transfer and releases everything never
 * adopted before the store retires.
 */
export class TransferStaging {
	readonly store: CompactContentStore;
	private readonly maxBytes: number;
	private readonly transfers = new Set<StagedTransfer>();
	private readonly staged = new Map<StagedContent, number>();
	private reserved = 0;
	private closed = false;

	constructor(store: CompactContentStore, maxBytes = TRANSFER_STAGING_MAX_BYTES) {
		this.store = store;
		this.maxBytes = maxBytes;
	}

	/** Stored bytes reserved by open transfers and committed content not yet adopted. */
	get stagedBytes(): number {
		return this.reserved;
	}

	/** Stored bytes of this store resident in RAM, staged and adopted alike. */
	get residentBytes(): number {
		return this.store.status().residentPayloadBytes;
	}

	begin(kind: BoundedId, id: BoundedId, length: number): StagedTransfer {
		if (this.closed) throw new TransferStagingError("staging_closed");
		if (!Number.isSafeInteger(length) || length < 0 || length % 2 !== 0)
			throw new TransferStagingError("length_mismatch");
		if (this.reserved + length > this.maxBytes) throw new TransferStagingError("staging_over_byte_limit");
		this.reserved += length;
		const transfer = new StagedTransfer(this.store, { kind, id, length }, (content) => {
			this.transfers.delete(transfer);
			if (content) this.staged.set(content, length);
			else this.reserved -= length;
		});
		this.transfers.add(transfer);
		return transfer;
	}

	/** One whole text staged as fragments of at most D stored bytes; a refusal leaves nothing staged. */
	stage(kind: BoundedId, id: BoundedId, text: string): StagedContent {
		const transfer = this.begin(kind, id, text.length * 2);
		try {
			for (let at = 0; at < text.length; at += FRAGMENT_MAX_UNITS)
				transfer.append(text.slice(at, at + FRAGMENT_MAX_UNITS));
			return transfer.commit();
		} catch (cause) {
			transfer.abort();
			throw cause;
		}
	}

	/** The acceptor takes the content: its bytes leave the staging bound and its leaves stay owned by the acceptor. */
	adopt(content: StagedContent): void {
		const bytes = this.staged.get(content);
		if (bytes === undefined) throw new CompactReadError("ownership");
		this.staged.delete(content);
		this.reserved -= bytes;
	}

	/** Drops the owner's live reference; content never adopted also leaves the staging bound. */
	release(content: StagedContent): void {
		const bytes = this.staged.get(content);
		if (bytes !== undefined) {
			this.staged.delete(content);
			this.reserved -= bytes;
		}
		for (const leaf of content.leaves) this.store.adjust(leaf, -1, 0);
	}

	/** Releases content only while it is still staged; adopted content is its acceptor's to release. */
	abandon(content: StagedContent): void {
		if (this.staged.has(content)) this.release(content);
	}

	/** A reader's pin: the leaves outlive every owner's release until the pin is returned. */
	pin(content: StagedContent, pins: 1 | -1): void {
		for (const leaf of content.leaves) this.store.adjust(leaf, 0, pins);
	}

	/** The content as S11a byte pages, its digest verified against the stored leaves before any range is served. */
	open(content: StagedContent, valid: () => void = () => {}): Promise<FrozenBytes> {
		return openFrozenBytes(content.ref.entry, content.leaves, (leaf) => this.store.readLeaf(leaf), valid);
	}

	/** The content's text in verified pieces of at most D stored bytes, one fragment resident beside one leaf. */
	async *chunks(content: StagedContent, valid?: () => void): AsyncGenerator<string> {
		const bytes = await this.open(content, valid);
		for (let at = 0; at < bytes.length; at += FRAGMENT_MAX_BYTES)
			yield (await bytes.range(at, Math.min(FRAGMENT_MAX_BYTES, bytes.length - at), valid)).toString("utf16le");
	}

	status(): StagingStatus {
		return { ...this.store.status(), stagedBytes: this.reserved, openTransfers: this.transfers.size };
	}

	idle(): Promise<void> {
		return this.store.idle();
	}

	close(): Promise<void> {
		this.closed = true;
		for (const transfer of [...this.transfers]) transfer.abort();
		for (const content of [...this.staged.keys()]) this.release(content);
		return this.store.retire();
	}
}
