import type { TranscriptRoot } from "./accepted-transcript.ts";
import { entryFamily, type FamilyProducers, familyId, memberId } from "./compact-catalog-registry.ts";
import {
	type CatalogReader,
	type CatalogStep,
	literalFields,
	literalSteps,
	objectSteps,
} from "./compact-catalog-steps.ts";
import { emptyComponent, stepsComponent } from "./compact-catalog-writer.ts";
import type { CatalogComponent } from "./compact-recovery-catalog.ts";
import type { SettledReader } from "./compact-settled-messages.ts";

const SOURCE = familyId("source");

/**
 * The source-metadata family (R4.B2, RULING-61 Q2): one `entry-<index>` member per accepted entry of this epoch whose
 * engine kind the registry maps to `source` (custom and custom_message payloads, compaction and branch summaries,
 * context edits, labels, model and configuration changes, usage), carrying its ancestry, the message it joined in
 * this epoch, and its exact retained line while the tail holds it (`null` once persistence covers it: S11 streams
 * those bytes). A loaded base is S11's, so the family is explicitly empty only when its producer is complete. The
 * tail is held for the whole walk, so an entry it holds streams to the end even if persistence releases it meanwhile.
 */
export async function* sourceComponents(
	reader: CatalogReader,
	transcript: TranscriptRoot,
	producers: FamilyProducers,
	settled: SettledReader,
): AsyncGenerator<CatalogComponent> {
	let count = 0;
	const accepted = transcript.unavailable === null ? transcript.accepted : [];
	const hold = transcript.tail.hold(transcript.count, transcript.base?.count ?? 0);
	try {
		for (const { index, id, kind, parentId } of accepted) {
			reader.valid();
			if (entryFamily(kind) !== "source") continue;
			const head = { index, id, parentId, kind, messageId: await settled.messageOf(id) };
			const steps = objectSteps([
				...literalFields(head),
				["entry", hold.has(index) ? rawSteps(hold.chunks(index, reader.valid)) : literalSteps(null)],
			]);
			yield* stepsComponent(reader.store, SOURCE, memberId("entry", index), steps);
			count += 1;
		}
	} finally {
		hold.release();
	}
	if (count === 0 && producers.source === "complete") yield emptyComponent("source");
}

/** Stored JSON text spliced in as one raw value: every piece but the last says more follows. */
async function* rawSteps(chunks: AsyncIterable<string>): AsyncGenerator<CatalogStep> {
	let previous: string | undefined;
	for await (const chunk of chunks) {
		if (previous !== undefined) yield { kind: "raw", text: previous, more: true };
		previous = chunk;
	}
	yield { kind: "raw", text: previous ?? "", more: false };
}
