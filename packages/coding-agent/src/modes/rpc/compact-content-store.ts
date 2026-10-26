import { CompactSpoolStorage, RECLAIM_WORK_ALLOWANCE_BYTES } from "./compact-spool-storage.ts";
import { type CompactStorageFailure, type CompactStorageIo, nodeCompactStorageIo } from "./compact-storage-io.ts";
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

export type LeafId = number;

export interface CompactStorageStatus {
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
	text: string | undefined;
	readonly units: number;
	live: number;
	pins: number;
	state: "ram" | "pending" | "committed";
	path?: string;
}

export class CompactContentStore extends CompactSpoolStorage {
	private readonly spillAboveBytes: number;
	private readonly spillTargetBytes: number;
	private readonly leaves = new Map<LeafId, Leaf>();
	/** Resident leaves in creation order, so each spill takes the oldest without rescanning committed ones. */
	private readonly ramLeaves = new Set<LeafId>();
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
	createLeaf(text: string): LeafId {
		this.assertReadable();
		if (text.length > COMPACT_LEAF_CODE_UNITS) throw new CompactReadError("size_limit");
		const id = this.nextLeafId++;
		this.leaves.set(id, { text, units: text.length, live: 1, pins: 0, state: "ram" });
		this.ramLeaves.add(id);
		this.residentPayloadBytes += text.length * 2;
		this.scheduleSpill();
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
		if (pinnedOnly !== (leaf.live === 0 && leaf.pins > 0)) this.pinnedOnlyBytes += (pinnedOnly ? -2 : 2) * leaf.units;
		if (leaf.live > 0 || leaf.pins > 0) return;
		this.leaves.delete(id);
		this.ramLeaves.delete(id);
		if (leaf.state === "committed" && leaf.path) {
			this.spilledLiveBytes -= leaf.units * 2;
			this.discard(leaf.path, leaf.units * 2);
			return;
		}
		this.residentPayloadBytes -= leaf.units * 2;
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
			return (await this.readFile(leaf.path ?? "", leaf.units * 2, "leaf_read")).toString("utf16le");
		} finally {
			this.adjust(id, 0, -1);
		}
	}

	status(): CompactStorageStatus {
		return {
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
		if (this.spillQueued || !this.spillAllowed || this.residentPayloadBytes <= this.spillAboveBytes) return;
		if (this.reclaimDebtBytes > RECLAIM_WORK_ALLOWANCE_BYTES) return;
		this.spillQueued = true;
		this.enqueue("spill_write", () => this.spillNext());
	}

	/** Spills one oldest resident leaf per job, so other storage work interleaves fairly. */
	private async spillNext(): Promise<void> {
		const [id] = this.ramLeaves;
		const leaf = id === undefined ? undefined : this.leaves.get(id);
		if (id === undefined || !leaf || leaf.text === undefined || !this.spillAllowed) {
			this.spillQueued = false;
			return;
		}
		const bytes = leaf.units * 2;
		leaf.state = "pending";
		this.ramLeaves.delete(id);
		let path: string | undefined;
		try {
			path = await this.writeFile(Buffer.from(leaf.text, "utf16le"), "spill_write", bytes);
		} finally {
			// A failed write, or a failure report that threw, keeps the leaf resident and spillable.
			if (path === undefined) {
				leaf.state = "ram";
				if (this.leaves.get(id) === leaf) this.ramLeaves.add(id);
			}
		}
		const owned = this.leaves.get(id) === leaf;
		if (path !== undefined && (!owned || this.retired)) {
			this.discard(path, bytes);
		} else if (path !== undefined) {
			leaf.state = "committed";
			leaf.path = path;
			leaf.text = undefined;
			this.residentPayloadBytes -= bytes;
			this.spilledLiveBytes += bytes;
			this.committed(id);
		}
		this.spillQueued = false;
		if (this.residentPayloadBytes > this.spillTargetBytes) {
			this.spillQueued = this.spillAllowed;
			if (this.spillQueued) this.enqueue("spill_write", () => this.spillNext());
		}
	}
}
