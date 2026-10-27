import type { CompactComponentRoots } from "./compact-component-roots.ts";
import type { CompactContentIndex, FrozenIndex } from "./compact-content-index.ts";
import type { CompactContentStore } from "./compact-content-store.ts";
import { readSeededBlock } from "./compact-seeded-block-view.ts";
import { type CompactMessageView, type FrozenBlock, readCompactBlocks } from "./compact-text-view.ts";
import type { CompactPersistence } from "./compact-transition.ts";
import type { ValueRef } from "./compact-values.ts";

export interface MessageRoot {
	readonly messageId: string;
	readonly blocks: ValueRef | undefined;
}
export interface SettledRow extends MessageRoot {
	readonly persistence: CompactPersistence;
}
export interface FrozenCompactState {
	readonly sequence: number;
	readonly active: ValueRef | undefined;
	readonly settled: FrozenIndex;
}
interface Components {
	readonly store: CompactContentStore;
	readonly settled: CompactContentIndex<SettledRow>;
	readonly blockRoots: CompactComponentRoots<FrozenBlock>;
	readonly messageRoots: CompactComponentRoots<MessageRoot>;
}

/** Whole-view compatibility assembly, called only while the owner holds its cut operation lease. */
export async function readCompactState(frozen: FrozenCompactState, components: Components, valid: () => void) {
	const readBlocks = async (ref: ValueRef | undefined) => {
		const blocks: FrozenBlock[] = [];
		for await (const [, block] of components.blockRoots.entries(ref, valid)) blocks.push(block);
		const view = await readCompactBlocks(components.store.text, blocks, valid);
		const content: object[] = [];
		for (const [index, block] of blocks.entries())
			if (block.seeded)
				content[block.contentIndex] = await readSeededBlock(components.store, block.seeded, {
					text: view[index].text,
					valid,
				});
		return { blocks: view, ...(content.length ? { message: { content } } : {}) };
	};
	const messages: CompactMessageView[] = [];
	for (const [messageId, row] of await components.settled.entries(frozen.settled))
		messages.push({ messageId, persistence: row.persistence, ...(await readBlocks(row.blocks)) });
	for await (const [, row] of components.messageRoots.entries(frozen.active, valid))
		messages.push({
			messageId: row.messageId,
			persistence: undefined,
			...(await readBlocks(row.blocks)),
		});
	valid();
	return { sequence: frozen.sequence, messages };
}
