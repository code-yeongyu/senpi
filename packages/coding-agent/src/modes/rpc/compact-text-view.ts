import { COMPACT_LEAF_CODE_UNITS, type LeafId } from "./compact-content-store.ts";
import type { CompactTextRoots } from "./compact-text-roots.ts";
import type { CompactBlockKind, CompactPersistence } from "./compact-transition.ts";

export interface FrozenBlock {
	readonly contentIndex: number;
	readonly kind: CompactBlockKind;
	readonly root: LeafId;
	/** A cut shares the immutable tail (under one leaf), not a new leaf for each freeze. */
	readonly tail: string;
}

export interface CompactMessageView {
	readonly messageId: string;
	readonly persistence: CompactPersistence | undefined;
	readonly blocks: readonly {
		readonly contentIndex: number;
		readonly kind: CompactBlockKind;
		readonly text: string;
	}[];
}

/** Compatibility assembly only; each underlying range is bounded, the resulting legacy view is not. */
export async function readCompactBlocks(
	texts: CompactTextRoots,
	blocks: readonly FrozenBlock[],
	valid: () => void,
): Promise<CompactMessageView["blocks"]> {
	const result = [];
	for (const { contentIndex, kind, root, tail } of blocks) {
		valid();
		const length = texts.units(root) + tail.length;
		let text = "";
		for (let offset = 0; offset < length; offset += COMPACT_LEAF_CODE_UNITS) {
			text += await texts.read(root, tail, offset, Math.min(COMPACT_LEAF_CODE_UNITS, length - offset), 2, valid);
		}
		result.push({ contentIndex, kind, text });
	}
	return result;
}
