import type { FrozenCalls } from "./compact-call-model.ts";
import type { CompactComponentRoots } from "./compact-component-roots.ts";
import type { CompactContentIndex, FrozenIndex } from "./compact-content-index.ts";
import type { CompactContentStore } from "./compact-content-store.ts";
import type { FrozenComponents } from "./compact-current-components.ts";
import type { FrozenSeededBlock } from "./compact-seeded-block.ts";
import { readSeededBlock, readSeededFields } from "./compact-seeded-block-view.ts";
import type { SeededFields } from "./compact-seeded-draft.ts";
import { type CompactMessageView, type FrozenBlock, readCompactBlocks } from "./compact-text-view.ts";
import type { CompactPersistence } from "./compact-transition.ts";
import type { ValueRef } from "./compact-values.ts";

export interface MessageRoot {
	readonly messageId: string;
	readonly blocks?: ValueRef | undefined;
	/** Public message fields (assistant content lives in `blocks`); absent for block-only messages. */
	readonly fields?: SeededFields;
	readonly correlation?: SeededFields;
}
export interface SettledRow extends MessageRoot {
	readonly persistence: CompactPersistence;
}
export interface FrozenCompactState {
	readonly sequence: number;
	readonly active: ValueRef | undefined;
	readonly settled: FrozenIndex;
	readonly components: FrozenComponents;
	readonly calls: FrozenCalls;
}
interface Components {
	readonly store: CompactContentStore;
	readonly settled: CompactContentIndex<SettledRow>;
	readonly blockRoots: CompactComponentRoots<FrozenBlock>;
	readonly messageRoots: CompactComponentRoots<MessageRoot>;
}
export interface ActiveBlockView {
	readonly contentIndex: number;
	readonly text: string;
	readonly phase: FrozenSeededBlock["phase"] | undefined;
	/** The public block at the cut; absent for a block that has no seed. */
	readonly block: Readonly<Record<string, unknown>> | undefined;
}
/** One live message at a cut: its public fields and the current value of every block it names (R3.C6.4). */
export interface ActiveMessageView {
	readonly messageId: string;
	readonly fields: Readonly<Record<string, unknown>> | undefined;
	readonly blocks: readonly ActiveBlockView[];
}

async function readRowBlocks(
	ref: ValueRef | undefined,
	components: Pick<Components, "store" | "blockRoots">,
	valid: () => void,
) {
	const blocks: FrozenBlock[] = [];
	for await (const [, block] of components.blockRoots.entries(ref, valid)) blocks.push(block);
	const view = await readCompactBlocks(components.store.text, blocks, valid);
	const content: Record<string, unknown>[] = [];
	for (const [index, block] of blocks.entries())
		if (block.seeded)
			content[block.contentIndex] = await readSeededBlock(components.store, block.seeded, {
				text: view[index].text,
				valid,
			});
	return { frozen: blocks, blocks: view, content };
}

/** The live messages of a cut, read for a legacy view; never the settled history. Called under the cut's lease. */
export async function readActiveMessages(
	frozen: FrozenCompactState,
	components: Pick<Components, "store" | "blockRoots" | "messageRoots">,
	valid: () => void,
): Promise<ActiveMessageView[]> {
	const messages: ActiveMessageView[] = [];
	for await (const [, row] of components.messageRoots.entries(frozen.active, valid)) {
		const { frozen: rows, blocks, content } = await readRowBlocks(row.blocks, components, valid);
		messages.push({
			messageId: row.messageId,
			fields: row.fields ? await readSeededFields(components.store, row.fields, valid) : undefined,
			blocks: rows.map((block, index) => ({
				contentIndex: block.contentIndex,
				text: blocks[index].text,
				phase: block.seeded?.phase,
				block: content[block.contentIndex],
			})),
		});
	}
	valid();
	return messages;
}

/** Whole-view compatibility assembly, called only while the owner holds its cut operation lease. */
export async function readCompactState(frozen: FrozenCompactState, components: Components, valid: () => void) {
	const readMessage = async (row: MessageRoot) => {
		const { blocks, content } = await readRowBlocks(row.blocks, components, valid);
		if (!row.fields) return { blocks, ...(content.length ? { message: { content } } : {}) };
		const fields = await readSeededFields(components.store, row.fields, valid);
		return {
			blocks,
			message: "content" in fields ? fields : { ...fields, content },
			...(row.correlation ? { correlation: await readSeededFields(components.store, row.correlation, valid) } : {}),
		};
	};
	const messages: CompactMessageView[] = [];
	for (const [messageId, row] of await components.settled.entries(frozen.settled))
		messages.push({ messageId, persistence: row.persistence, ...(await readMessage(row)) });
	for await (const [, row] of components.messageRoots.entries(frozen.active, valid))
		messages.push({ messageId: row.messageId, persistence: undefined, ...(await readMessage(row)) });
	valid();
	return { sequence: frozen.sequence, messages };
}
