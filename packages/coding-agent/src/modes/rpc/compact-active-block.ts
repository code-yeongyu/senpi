import { COMPACT_LEAF_CODE_UNITS, type CompactContentStore, type LeafId } from "./compact-content-store.ts";
import type { ComponentRoot } from "./compact-component-roots.ts";
import type { SeededBlock } from "./compact-seeded-block.ts";
import type { SeededFields } from "./compact-seeded-draft.ts";
import type { FrozenBlock } from "./compact-text-view.ts";
import { type CompactBlockKind, CompactTransitionError } from "./compact-transition.ts";

export interface ActiveBlock {
	readonly kind: CompactBlockKind;
	readonly seeded?: SeededBlock;
	readonly epoch?: string;
	root: LeafId;
	tail: string;
	tailRoot: LeafId;
	units: number;
	emitted: number;
	covered: number;
	witness: string;
}

export interface ActiveMessage {
	readonly order: string;
	readonly blocks: Map<number, ActiveBlock>;
	readonly epoch?: string;
	readonly correlation?: SeededFields;
	root: ComponentRoot<FrozenBlock>;
	fields?: SeededFields;
	tailBytes: number;
	witnessBytes: number;
}

export function appendBlock(store: CompactContentStore, block: ActiveBlock, text: string): void {
	block.units += text.length;
	let rest = text;
	while (block.tail.length + rest.length >= COMPACT_LEAF_CODE_UNITS) {
		const take = COMPACT_LEAF_CODE_UNITS - block.tail.length;
		block.root = store.text.append(block.root, block.tail + rest.slice(0, take));
		store.adjust(block.tailRoot, -1, 0);
		block.tailRoot = 0;
		block.tail = "";
		rest = rest.slice(take);
	}
	// Only the suffix enters structural storage; sealing coalesces it into one payload leaf.
	if (rest.length) block.tailRoot = store.text.append(block.tailRoot, rest, true);
	block.tail += rest;
}

export function adjustBlock(store: CompactContentStore, block: ActiveBlock, live: number): void {
	store.adjust(block.root, live, 0);
	store.adjust(block.tailRoot, live, 0);
}

/** Validate before touching the live text owner or its replay witness. */
export function deltaBlock(store: CompactContentStore, block: ActiveBlock, offset: number, text: string): void {
	if (offset !== block.emitted)
		throw new CompactTransitionError("non_contiguous", `offset ${offset}, expected ${block.emitted}`);
	const overlapEnd = Math.min(offset + text.length, block.units);
	const overlap = Math.max(0, overlapEnd - offset);
	if (overlap > 0 && text.slice(0, overlap) !== block.witness.slice(offset, overlapEnd))
		throw new CompactTransitionError("conflicting_overlap", `[${offset}, ${overlapEnd})`);
	appendBlock(store, block, text.slice(overlap));
	block.emitted = offset + text.length;
	if (block.emitted >= block.covered) block.witness = "";
}
