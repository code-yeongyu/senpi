import type { LeafId } from "./compact-content-store.ts";
import type { CompactTextRoots } from "./compact-text-roots.ts";
import type { FrozenSeededBlock } from "./compact-seeded-block.ts";
import type { CompactBlockKind, CompactPersistence } from "./compact-transition.ts";

export interface FrozenBlock {
	readonly contentIndex: number;
	readonly kind: CompactBlockKind;
	readonly root: LeafId;
	readonly seeded?: FrozenSeededBlock;
	/** Legacy view tail; current owners put tails in tailRoot and leave this empty. */
	readonly tail: string;
	/** Append-only structural tail; the hot string is never re-owned on each delta. */
	readonly tailRoot?: LeafId;
}

export interface CompactMessageView {
	readonly messageId: string;
	readonly persistence: CompactPersistence | undefined;
	readonly message?: Readonly<Record<string, unknown>>;
	readonly correlation?: Readonly<Record<string, unknown>>;
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
	for (const { contentIndex, kind, root, tail, tailRoot } of blocks) {
		valid();
		let text = "";
		for await (const chunk of texts.chunks(root, valid)) text += chunk;
		for await (const chunk of texts.chunks(tailRoot ?? 0, valid)) text += chunk;
		text += tail;
		result.push({ contentIndex, kind, text });
	}
	return result;
}
