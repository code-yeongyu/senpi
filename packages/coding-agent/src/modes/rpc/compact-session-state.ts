import { CompactContentIndex, type FrozenIndex } from "./compact-content-index.ts";
import {
	COMPACT_LEAF_CODE_UNITS,
	CompactContentStore,
	type CompactContentStoreOptions,
	type CompactStorageStatus,
	type LeafId,
} from "./compact-content-store.ts";
import {
	type BlockAddress,
	type CompactBlockKind,
	type CompactPersistence,
	type CompactTransition,
	CompactTransitionError,
} from "./compact-transition.ts";

/**
 * The in-memory current-state owner over compact storage (senpi#4272, R3.C6.4 first half).
 *
 * `accept` is synchronous: it validates a typed transition completely, then publishes the next
 * sequence, or throws and leaves the prior root untouched. Block text lives in owned bounded leaves
 * that spill asynchronously; settled messages live in a spillable index whose persistence status
 * changes only through `message_status`, never through storage success or failure. `freeze` pins
 * an immutable cut synchronously, and `read` materializes it asynchronously from RAM or disk.
 */

interface FrozenBlock {
	readonly contentIndex: number;
	readonly kind: CompactBlockKind;
	readonly leaves: readonly LeafId[];
	/** A cut shares the immutable active tail string (under one leaf) instead of minting a leaf per freeze. */
	readonly tail: string;
}

interface ActiveBlock {
	readonly kind: CompactBlockKind;
	readonly leaves: LeafId[];
	tail: string;
	units: number;
	emitted: number;
	covered: number;
	/** The declared replay range, kept resident until emission passes it; counted as hot bytes. */
	witness: string;
}

interface SettledRow {
	readonly persistence: CompactPersistence;
	readonly blocks: readonly FrozenBlock[];
}

interface FrozenCompactState {
	readonly sequence: number;
	readonly active: ReadonlyMap<string, readonly FrozenBlock[]>;
	readonly settled: FrozenIndex<SettledRow>;
}

interface CompactMessageView {
	readonly messageId: string;
	readonly persistence: CompactPersistence | undefined;
	readonly blocks: readonly {
		readonly contentIndex: number;
		readonly kind: CompactBlockKind;
		readonly text: string;
	}[];
}

export interface CompactSessionStateOptions extends CompactContentStoreOptions {
	/** Index compaction is considered once this many override slots exist (one page by default). */
	readonly compactAboveRows?: number;
}

const byContentIndex = ([a]: [number, ActiveBlock], [b]: [number, ActiveBlock]) => a - b;

export class CompactSessionState {
	private readonly store: CompactContentStore;
	private readonly settled: CompactContentIndex<SettledRow>;
	private readonly active = new Map<string, Map<number, ActiveBlock>>();
	private sequence = 0;
	private frozenTailBytes = 0;

	constructor(options: CompactSessionStateOptions) {
		this.store = new CompactContentStore(options);
		const leavesOf = (row: SettledRow) => row.blocks.flatMap((block) => block.leaves);
		this.settled = new CompactContentIndex(this.store, leavesOf, options.compactAboveRows ?? 128);
	}

	get acceptedSequence(): number {
		return this.sequence;
	}

	accept(transition: CompactTransition): number {
		switch (transition.type) {
			case "block_start":
				this.start(transition);
				break;
			case "block_delta":
				this.delta(this.block(transition), transition.offset, transition.text);
				break;
			case "block_replace":
				this.replace(this.block(transition), transition.text);
				break;
			case "message_status":
				this.setPersistence(transition.messageId, transition.persistence);
				break;
			case "message_remove":
				this.remove(transition.messageId);
				break;
		}
		return ++this.sequence;
	}

	freeze(): FrozenCompactState {
		const active = new Map<string, FrozenBlock[]>();
		for (const [messageId, blocks] of this.active) active.set(messageId, this.seal(blocks, false));
		for (const blocks of active.values()) this.pin(blocks, 1);
		return { sequence: this.sequence, active, settled: this.settled.freeze() };
	}

	release(frozen: FrozenCompactState): void {
		for (const blocks of frozen.active.values()) this.pin(blocks, -1);
		this.settled.release(frozen.settled);
	}

	/** Rejects with the storage error when committed content is gone; never returns empty content for it. */
	async read(frozen: FrozenCompactState): Promise<{ sequence: number; messages: CompactMessageView[] }> {
		const messages: CompactMessageView[] = [];
		for (const [messageId, row] of await this.settled.entries(frozen.settled)) {
			messages.push({ messageId, persistence: row.persistence, blocks: await this.texts(row.blocks) });
		}
		for (const [messageId, blocks] of frozen.active) {
			messages.push({ messageId, persistence: undefined, blocks: await this.texts(blocks) });
		}
		return { sequence: frozen.sequence, messages };
	}

	storageStatus(): CompactStorageStatus &
		ReturnType<CompactContentIndex<SettledRow>["status"]> & {
			readonly residentTailBytes: number;
			/** Active tails held by unreleased cuts; may share storage with `residentTailBytes`. */
			readonly frozenTailBytes: number;
			readonly hotWitnessBytes: number;
		} {
		let residentTailBytes = 0;
		let hotWitnessBytes = 0;
		for (const blocks of this.active.values()) {
			for (const block of blocks.values()) {
				residentTailBytes += block.tail.length * 2;
				hotWitnessBytes += block.witness.length * 2;
			}
		}
		return {
			...this.store.status(),
			...this.settled.status(),
			residentTailBytes,
			frozenTailBytes: this.frozenTailBytes,
			hotWitnessBytes,
		};
	}

	idle(): Promise<void> {
		return this.store.idle();
	}

	retire(): Promise<void> {
		return this.store.retire();
	}

	private start(t: Extract<CompactTransition, { type: "block_start" }>): void {
		if (this.active.get(t.messageId)?.has(t.contentIndex) || this.settled.has(t.messageId)) {
			throw new CompactTransitionError("duplicate_block", `${t.messageId}#${t.contentIndex}`);
		}
		const covered = t.coveredCodeUnits;
		if (!Number.isInteger(covered) || (covered !== 0 && covered !== t.seed.length)) {
			throw new CompactTransitionError("invalid_coverage", `${covered} of ${t.seed.length} seed code units`);
		}
		const emitted = covered > 0 ? 0 : t.seed.length;
		const block: ActiveBlock = { kind: t.kind, leaves: [], tail: "", units: 0, emitted, covered, witness: "" };
		block.witness = t.seed.slice(0, covered);
		this.append(block, t.seed);
		const blocks = this.active.get(t.messageId) ?? new Map<number, ActiveBlock>();
		blocks.set(t.contentIndex, block);
		this.active.set(t.messageId, blocks);
	}

	/**
	 * Appends only the new suffix. Overlap exists only while a fully covered seed is being replayed
	 * (`emitted < covered == units`), so it always lies inside the producer-declared coverage.
	 */
	private delta(block: ActiveBlock, offset: number, text: string): void {
		if (offset !== block.emitted) {
			throw new CompactTransitionError("non_contiguous", `offset ${offset}, expected ${block.emitted}`);
		}
		const overlapEnd = Math.min(offset + text.length, block.units);
		const overlap = Math.max(0, overlapEnd - offset);
		if (overlap > 0 && text.slice(0, overlap) !== block.witness.slice(offset, overlapEnd)) {
			throw new CompactTransitionError("conflicting_overlap", `[${offset}, ${overlapEnd})`);
		}
		this.append(block, text.slice(overlap));
		block.emitted = offset + text.length;
		if (block.emitted >= block.covered) block.witness = "";
	}

	private replace(block: ActiveBlock, text: string): void {
		for (const id of block.leaves.splice(0)) this.store.adjust(id, -1, 0);
		block.tail = "";
		block.units = 0;
		block.covered = 0;
		block.witness = "";
		this.append(block, text);
		block.emitted = block.units;
	}

	private setPersistence(messageId: string, persistence: CompactPersistence): void {
		const blocks = this.active.get(messageId);
		if (blocks) {
			this.settled.set(messageId, { persistence, blocks: this.seal(blocks, true) });
			for (const block of blocks.values()) for (const id of block.leaves) this.store.adjust(id, -1, 0);
			this.active.delete(messageId);
		} else if (this.settled.has(messageId)) {
			this.settled.patch(messageId, { persistence });
		} else {
			throw new CompactTransitionError("unknown_message", messageId);
		}
	}

	private remove(messageId: string): void {
		const blocks = this.active.get(messageId);
		const settled = this.settled.has(messageId);
		if (!blocks && !settled) throw new CompactTransitionError("unknown_message", messageId);
		for (const block of blocks?.values() ?? []) for (const id of block.leaves) this.store.adjust(id, -1, 0);
		this.active.delete(messageId);
		if (settled) this.settled.delete(messageId);
	}

	private block(address: BlockAddress): ActiveBlock {
		const block = this.active.get(address.messageId)?.get(address.contentIndex);
		if (!block) throw new CompactTransitionError("unknown_block", `${address.messageId}#${address.contentIndex}`);
		return block;
	}

	private append(block: ActiveBlock, text: string): void {
		block.units += text.length;
		let rest = text;
		while (block.tail.length + rest.length >= COMPACT_LEAF_CODE_UNITS) {
			const take = COMPACT_LEAF_CODE_UNITS - block.tail.length;
			block.leaves.push(this.store.createLeaf(block.tail + rest.slice(0, take)));
			block.tail = "";
			rest = rest.slice(take);
		}
		block.tail += rest;
	}

	/** Settling mints the final tail into a spillable leaf; a freeze of an active block shares the tail. */
	private seal(blocks: Map<number, ActiveBlock>, settle: boolean): FrozenBlock[] {
		return [...blocks].sort(byContentIndex).map(([contentIndex, block]) => {
			if (settle && block.tail.length > 0) {
				block.leaves.push(this.store.createLeaf(block.tail));
				block.tail = "";
			}
			return { contentIndex, kind: block.kind, leaves: [...block.leaves], tail: block.tail };
		});
	}

	private pin(blocks: readonly FrozenBlock[], delta: number): void {
		for (const block of blocks) {
			this.frozenTailBytes += delta * block.tail.length * 2;
			for (const id of block.leaves) this.store.adjust(id, 0, delta);
		}
	}

	private async texts(blocks: readonly FrozenBlock[]): Promise<CompactMessageView["blocks"]> {
		return Promise.all(
			blocks.map(async ({ contentIndex, kind, leaves, tail }) => {
				const parts = await Promise.all(leaves.map((id) => this.store.readLeaf(id)));
				return { contentIndex, kind, text: parts.join("") + tail };
			}),
		);
	}
}
