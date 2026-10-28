import type { TranscriptRoot } from "./accepted-transcript.ts";
import { entryFamily, type FamilyProducers, familyId, memberId } from "./compact-catalog-registry.ts";
import { type CatalogReader, literalFields, literalSteps, objectSteps } from "./compact-catalog-steps.ts";
import { emptyComponent, stepsComponent } from "./compact-catalog-writer.ts";
import type { CatalogComponent } from "./compact-recovery-catalog.ts";
import type { SettledReader } from "./compact-settled-messages.ts";

const SOURCE = familyId("source");

/**
 * The source-metadata family (R4.B2, RULING-61 Q2): one `entry-<index>` member per accepted entry of this epoch whose
 * engine kind the registry maps to `source` (custom and custom_message payloads, compaction and branch summaries,
 * context edits, labels, model and configuration changes, usage), carrying its ancestry, the message it joined in
 * this epoch, and its exact retained line while the tail holds it (`null` once persistence covers it: S11 streams
 * those bytes). A loaded base is S11's, so the family is explicitly empty only when its producer is complete.
 */
export async function* sourceComponents(
	reader: CatalogReader,
	transcript: TranscriptRoot,
	producers: FamilyProducers,
	settled: SettledReader,
): AsyncGenerator<CatalogComponent> {
	let count = 0;
	for (let index = 0; transcript.unavailable === null && index < transcript.count; index++) {
		reader.valid();
		const kind = transcript.kinds[index];
		if (entryFamily(kind) !== "source") continue;
		const id = transcript.entryIds[index];
		const line = transcript.tail.entries.get(index);
		const head = { index, id, parentId: transcript.parents[index], kind, messageId: await settled.messageOf(id) };
		const steps = objectSteps([
			...literalFields(head),
			["entry", line === undefined ? literalSteps(null) : [{ kind: "raw", text: line, more: false } as const]],
		]);
		yield* stepsComponent(reader.store, SOURCE, memberId("entry", index), steps);
		count += 1;
	}
	if (count === 0 && producers.source === "complete") yield emptyComponent("source");
}
