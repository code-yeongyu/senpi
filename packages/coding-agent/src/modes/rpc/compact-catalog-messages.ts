import { familyId, memberId } from "./compact-catalog-registry.ts";
import {
	arraySteps,
	type CatalogReader,
	fieldSteps,
	literalSteps,
	objectSteps,
	type Steps,
	textSteps,
} from "./compact-catalog-steps.ts";
import { emptyComponent, stepsComponent } from "./compact-catalog-writer.ts";
import { CompactComponentRoots } from "./compact-component-roots.ts";
import type { CatalogComponent } from "./compact-recovery-catalog.ts";
import type { MessageRoot } from "./compact-state-view.ts";
import type { FrozenBlock } from "./compact-text-view.ts";
import type { ValueRef } from "./compact-values.ts";

const ACTIVE = familyId("active");

/** One live block: its public descriptor, its full text, and the seeded state (parse frontier, fields, signature). */
function blockSteps({ store, values, valid }: CatalogReader, block: FrozenBlock): Steps {
	const seeded = block.seeded;
	return objectSteps([
		["contentIndex", literalSteps(block.contentIndex)],
		["kind", literalSteps(block.kind)],
		["text", textSteps(store.text, [block.root, block.tailRoot ?? 0], valid, block.tail)],
		[
			"seeded",
			seeded
				? objectSteps([
						["type", literalSteps(seeded.type)],
						["phase", literalSteps(seeded.phase)],
						["parsedThrough", literalSteps(seeded.parsedThrough)],
						["fields", fieldSteps(values, seeded.fields, valid)],
						["signature", textSteps(store.text, [seeded.signature.root, seeded.signature.tailRoot], valid)],
					])
				: literalSteps(null),
		],
	]);
}

async function* blockItems(
	reader: CatalogReader,
	blocks: CompactComponentRoots<FrozenBlock>,
	ref: ValueRef | undefined,
): AsyncGenerator<Steps> {
	for await (const [, block] of blocks.entries(ref, reader.valid)) yield blockSteps(reader, block);
}

/** One live message: its public fields and correlation, then every block it names in content order. */
function messageSteps(reader: CatalogReader, row: MessageRoot, blocks: CompactComponentRoots<FrozenBlock>): Steps {
	const { values, valid } = reader;
	return objectSteps([
		["messageId", literalSteps(row.messageId)],
		["fields", row.fields ? fieldSteps(values, row.fields, valid) : literalSteps(null)],
		["correlation", row.correlation ? fieldSteps(values, row.correlation, valid) : literalSteps(null)],
		["blocks", arraySteps(blockItems(reader, blocks, row.blocks))],
	]);
}

/**
 * The active family (R4.B2, R3.C6.4): one `message-<order>` member per live message of the cut, its text streamed
 * from the stored ranges and its fields walked with one page resident, or the explicit empty when none is live.
 */
export async function* activeComponents(
	reader: CatalogReader,
	active: ValueRef | undefined,
): AsyncGenerator<CatalogComponent> {
	const messages = new CompactComponentRoots<MessageRoot>(reader.store, () => []);
	const blocks = new CompactComponentRoots<FrozenBlock>(reader.store, () => []);
	let count = 0;
	for await (const [order, row] of messages.entries(active, reader.valid)) {
		yield* stepsComponent(
			reader.store,
			ACTIVE,
			memberId("message", Number(order)),
			messageSteps(reader, row, blocks),
		);
		count += 1;
	}
	if (count === 0) yield emptyComponent("active");
}
