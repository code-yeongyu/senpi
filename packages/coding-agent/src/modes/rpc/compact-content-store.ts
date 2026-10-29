import { type CompactPlacement, CompactSegmentStorage, type CompactSlot } from "./compact-segment-storage.ts";
import { RECLAIM_WORK_ALLOWANCE_BYTES } from "./compact-spool-storage.ts";
import {
	type CompactStorageFailure,
	type CompactStorageIo,
	type CompactStorageOperation,
	nodeCompactStorageIo,
} from "./compact-storage-io.ts";
import { CompactReadError } from "./compact-read-lease.ts";
import { CompactTextRoots } from "./compact-text-roots.ts";

/**
 * Owned bounded leaves for compact current state (senpi#4272, R3.C6.4 / R3.C2.4).
 *
 * Acceptance never waits here: a leaf is created synchronously in RAM, and a spill only relocates
 * that immutable value. Its RAM copy is released only after the whole file was written and closed;
 * a failed write keeps the bytes resident, halts further spilling and is reported through
 * `status()`, never dropped. All storage work runs as one serial asynchronous job chain.
 */

/** 32,768 UTF-16 code units (64 KiB as UTF-16LE), so a split surrogate survives a leaf boundary exactly. */
export const COMPACT_LEAF_CODE_UNITS = 32_768;
/** Structural leaves committed per segment: one compaction round's selection, never one file per leaf. */
const VALUE_FLUSH_BATCH = 128;

export type LeafId = number;

export class CompactWriteError extends Error {
	readonly reason:
		| "size_limit"
		| "storage_unavailable"
		| "depth_limit"
		| "count_limit"
		| "cycle"
		| "unsupported_value";

	constructor(reason: CompactWriteError["reason"]) {
		super(`compact write refused (${reason})`);
		this.name = "CompactWriteError";
		this.reason = reason;
	}
}

export interface CompactStorageStatus {
	readonly structuredBytes: { readonly resident: number; readonly spilled: number; readonly pinned: number };
	readonly residentPayloadBytes: number;
	readonly pendingIoCopyBytes: number;
	readonly pinnedOnlyBytes: number;
	readonly spilledLiveBytes: number;
	readonly spillBytesWritten: number;
	readonly reclaimDebtBytes: number;
	/** Resident bytes above the spill target that a halted spool keeps in RAM (ruling 08 condition 1). */
	readonly spillFailureRetainedBytes: number;
	readonly spillHalted: boolean;
	readonly failures: readonly CompactStorageFailure[];
}

export interface CompactContentStoreOptions {
	/** Private epoch spool directory the store creates itself (0700, never an existing one; files 0600). Not a transcript. */
	readonly dir: string;
	readonly io?: CompactStorageIo;
	/** Spilling starts above this many resident leaf bytes and stops at the target. */
	readonly spillAboveBytes?: number;
	readonly spillTargetBytes?: number;
}

interface Leaf {
	readonly value: boolean;
	text: string | undefined;
	readonly units: number;
	live: number;
	pins: number;
	state: "ram" | "pending" | "committed";
	slot?: CompactSlot;
	file?: { readonly path: string; readonly bytes: number };
}

export class CompactContentStore extends CompactSegmentStorage {
	private readonly spillAboveBytes: number;
	private readonly spillTargetBytes: number;
	private readonly leaves = new Map<LeafId, Leaf>();
	/** Resident leaves in creation order, so each spill takes the oldest without rescanning committed ones. */
	private readonly ramLeaves = new Set<LeafId>();
	private readonly ramValues = new Set<LeafId>();
	private valueQueued = false;
	private readonly structuredBytes = { resident: 0, spilled: 0, pinned: 0 };
	private nextLeafId = 1;
	private residentPayloadBytes = 0;
	private pinnedOnlyBytes = 0;
	private spilledLiveBytes = 0;
	private readonly subscribers = new Set<(id: LeafId) => void>();
	readonly text = new CompactTextRoots(this);

	subscribeCommitted(listener: (id: LeafId) => void): void {
		this.subscribers.add(listener);
	}

	committed(id: LeafId): void {
		for (const listener of this.subscribers) listener(id);
	}

	leafUnits(id: LeafId): number {
		const leaf = this.leaves.get(id);
		if (!leaf) throw new CompactReadError("ownership");
		return leaf.units;
	}

	constructor(options: CompactContentStoreOptions) {
		super(options.dir, options.io ?? nodeCompactStorageIo);
		this.spillAboveBytes = options.spillAboveBytes ?? 4 * 1024 * 1024;
		this.spillTargetBytes = options.spillTargetBytes ?? 2 * 1024 * 1024;
	}

	/** Takes ownership of an immutable value with one live reference. */
	createLeaf(text: string, value = false): LeafId {
		this.assertReadable();
		if (text.length > COMPACT_LEAF_CODE_UNITS) throw new CompactWriteError("size_limit");
		const id = this.nextLeafId++;
		this.leaves.set(id, { text, units: text.length, value, live: 1, pins: 0, state: "ram" });
		(value ? this.ramValues : this.ramLeaves).add(id);
		if (value) this.structuredBytes.resident += text.length * 2;
		else this.residentPayloadBytes += text.length * 2;
		this.scheduleSpill();
		return id;
	}

	/** A committed index file participates in the same ownership graph as its descriptors. */
	ownFile(path: string, bytes: number): LeafId {
		const id = this.createLeaf("", true);
		const leaf = this.leaves.get(id);
		if (!leaf) throw new CompactReadError("ownership");
		leaf.file = { path, bytes };
		return id;
	}

	/** Moves live and cut-pin references; the last reference drops RAM or reclaims the file. */
	adjust(id: LeafId, live: number, pins: number): void {
		if (id === 0) return;
		if (id < 0) return this.text.adjust(id, live, pins);
		const leaf = this.leaves.get(id);
		if (!leaf || leaf.live + live < 0 || leaf.pins + pins < 0) throw new CompactReadError("ownership");
		const pinnedOnly = leaf.live === 0 && leaf.pins > 0;
		leaf.live += live;
		leaf.pins += pins;
		if (pinnedOnly !== (leaf.live === 0 && leaf.pins > 0)) {
			const bytes = (pinnedOnly ? -2 : 2) * leaf.units;
			if (leaf.value) this.structuredBytes.pinned += bytes;
			else this.pinnedOnlyBytes += bytes;
		}
		if (leaf.live > 0 || leaf.pins > 0) return;
		this.leaves.delete(id);
		if (leaf.file) this.discard(leaf.file.path, leaf.file.bytes);
		(leaf.value ? this.ramValues : this.ramLeaves).delete(id);
		if (leaf.state === "committed" && leaf.slot) {
			if (leaf.value) this.structuredBytes.spilled -= leaf.units * 2;
			else this.spilledLiveBytes -= leaf.units * 2;
			this.leave(id, leaf.slot);
			return;
		}
		if (leaf.value) this.structuredBytes.resident -= leaf.units * 2;
		else this.residentPayloadBytes -= leaf.units * 2;
	}

	isCommitted(id: LeafId): boolean {
		if (id <= 0) return id === 0 || this.text.isCommitted(id);
		return this.leaves.get(id)?.state === "committed";
	}

	/** Reads a leaf the caller still references, from RAM or its committed file. */
	async readLeaf(id: LeafId): Promise<string> {
		this.assertReadable();
		const leaf = this.leaves.get(id);
		if (!leaf) throw new CompactReadError("ownership");
		this.adjust(id, 0, 1);
		try {
			if (leaf.text !== undefined) return leaf.text;
			if (!leaf.slot) throw new CompactReadError("ownership");
			return (await this.readSlot(leaf.slot)).toString("utf16le");
		} finally {
			this.adjust(id, 0, -1);
		}
	}

	status(): CompactStorageStatus {
		return {
			structuredBytes: { ...this.structuredBytes },
			residentPayloadBytes: this.residentPayloadBytes,
			pendingIoCopyBytes: this.pendingIoCopyBytes,
			pinnedOnlyBytes: this.pinnedOnlyBytes,
			spilledLiveBytes: this.spilledLiveBytes,
			spillBytesWritten: this.spillBytesWritten,
			reclaimDebtBytes: this.reclaimDebtBytes,
			spillFailureRetainedBytes: this.spillStopped
				? Math.max(0, this.residentPayloadBytes - this.spillTargetBytes)
				: 0,
			spillHalted: this.spillStopped,
			failures: [...this.failures],
		};
	}

	protected scheduleSpill(): void {
		if (
			!this.valueQueued &&
			this.spillAllowed &&
			this.ramValues.size &&
			this.reclaimDebtBytes <= RECLAIM_WORK_ALLOWANCE_BYTES
		) {
			this.valueQueued = true;
			this.enqueue("value_write", async () => {
				try {
					await this.flushValues();
				} finally {
					this.valueQueued = false;
				}
				this.scheduleSpill();
			});
		}
		if (this.spillQueued || !this.spillAllowed || this.residentPayloadBytes <= this.spillAboveBytes) return;
		if (this.reclaimDebtBytes > RECLAIM_WORK_ALLOWANCE_BYTES) return;
		this.spillQueued = true;
		this.enqueue("spill_write", () => this.spillNext());
	}

	/** Spills one oldest resident leaf per job, so other storage work interleaves fairly. */
	private async spillNext(): Promise<void> {
		const [id] = this.ramLeaves;
		if (id !== undefined) await this.flushLeaf(id);
		this.spillQueued = false;
		if (this.residentPayloadBytes > this.spillTargetBytes) {
			this.spillQueued = this.spillAllowed && this.ramLeaves.size > 0;
			if (this.spillQueued) this.enqueue("spill_write", () => this.spillNext());
		}
	}

	/** Commits at most one batch of structural leaves, in page-bounded segments, ahead of a cold-index rewrite. */
	async flushValues(): Promise<void> {
		// Amortize a cold-index rewrite across a bounded batch, without waiting for every pending owner.
		if (this.spillStopped) return;
		const batch: (readonly [LeafId, number])[] = [];
		for (const id of this.ramValues) {
			batch.push([id, this.leafUnits(id) * 2]);
			if (batch.length === VALUE_FLUSH_BATCH) break;
		}
		// A failed run halts spilling, so flushLeaves leaves the later runs resident.
		for (const run of this.segmentRuns(batch)) await this.flushLeaves(run);
	}

	/** Serial storage jobs can flush one newly built structural page without waiting on their own queue. */
	flushLeaf(id: LeafId): Promise<void> {
		return this.flushLeaves([id]);
	}

	/**
	 * Writes the resident leaves among `ids`, all of one kind, as segment files of at most 64 KiB each, then
	 * publishes them in one synchronous step once the last file is durable: that step is the batch's commit
	 * record, so no leaf is committed and no file is reachable before every file of the batch exists. A
	 * compaction round passes `node_write`; its files get the `node-` prefix.
	 */
	async flushLeaves(ids: Iterable<LeafId>, operation?: CompactStorageOperation): Promise<void> {
		if (!this.spillAllowed) return;
		const batch: [LeafId, Leaf, string][] = [];
		for (const id of ids) {
			const leaf = this.leaves.get(id);
			if (leaf?.state !== "ram" || leaf.text === undefined) continue;
			leaf.state = "pending";
			(leaf.value ? this.ramValues : this.ramLeaves).delete(id);
			batch.push([id, leaf, leaf.text]);
		}
		if (!batch.length) return;
		let placements: readonly CompactPlacement[] | undefined;
		try {
			const texts = batch.map(([, , text]) => text);
			placements = await this.writeSegments(texts, operation ?? (batch[0][1].value ? "value_write" : "spill_write"));
		} finally {
			// A failed write, or a failure report that threw, keeps the leaves resident and spillable.
			for (const [id, leaf] of placements ? [] : batch) {
				leaf.state = "ram";
				if (this.leaves.get(id) === leaf) (leaf.value ? this.ramValues : this.ramLeaves).add(id);
			}
		}
		if (!placements) return;
		// Publication point: every file of the batch is durable and nothing below awaits, so the batch becomes
		// visible here as a whole. The commit record is this in-memory step; the spool is never crash-recovery state
		// (a crashed epoch directory is refused as pre_existing and the state is rebuilt from the transcript).
		// If a future slice ever adopts a spool for crash recovery, it must first add a durable commit record written last.
		const placed: LeafId[] = [];
		for (const [n, [id, leaf]] of batch.entries()) {
			const [segment, offset] = placements[n];
			const bytes = leaf.units * 2;
			// A leaf released during the write, or any leaf once retirement began, is not published.
			if (this.leaves.get(id) === leaf && !this.retired) {
				leaf.state = "committed";
				leaf.text = undefined;
				leaf.slot = this.place(segment, id, offset, bytes);
				if (leaf.value) {
					this.structuredBytes.resident -= bytes;
					this.structuredBytes.spilled += bytes;
				} else {
					this.residentPayloadBytes -= bytes;
					this.spilledLiveBytes += bytes;
				}
				placed.push(id);
			}
		}
		for (const segment of new Set(placements.map(([segment]) => segment))) this.settle(segment);
		for (const id of placed) this.committed(id);
	}
}
