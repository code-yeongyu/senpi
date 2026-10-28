import type { TranscriptRoot } from "./accepted-transcript.ts";
import { entryFamily, type FamilyProducers, familyId, memberId } from "./compact-catalog-registry.ts";
import { writtenComponent } from "./compact-catalog-writer.ts";
import type { CompactContentStore } from "./compact-content-store.ts";
import type { CatalogComponent } from "./compact-recovery-catalog.ts";
import { protocolId } from "./compact-recovery-ids.ts";

const TRANSCRIPT = familyId("transcript");
const OPAQUE = familyId("opaque");
const BASE = protocolId("base");

/** The transcript family's definition: the frozen root's identity, never a byte of the session file. */
interface TranscriptDescriptor {
	readonly historyVersion: number;
	readonly leafId: string | null;
	readonly count: number;
	readonly base: { readonly count: number; readonly idFingerprint: string } | null;
	readonly persisted: number | null;
	readonly unavailable: string | null;
}

/**
 * The loaded base (entries from before this epoch) as the one file range the page route streams through the captured
 * identity under `<catalogRoot>:base` (S11c, `compact-recovery-base.ts`): one stamped row per entry, so each family a
 * base entry can belong to (transcript, opaque, source) names the stream with this row as its `base` member and
 * never claims emptiness the stream could contradict.
 */
interface BaseRow {
	readonly source: "file";
	readonly first: 0;
	readonly count: number;
	readonly idFingerprint: string;
}

/** The base row's text when the root has a non-empty loaded base, else undefined. */
export function baseRow(transcript: TranscriptRoot): string | undefined {
	if (transcript.unavailable !== null || !transcript.base || transcript.base.count === 0) return undefined;
	const row: BaseRow = {
		source: "file",
		first: 0,
		count: transcript.base.count,
		idFingerprint: transcript.base.idFingerprint,
	};
	return JSON.stringify(row);
}

/**
 * One accepted entry of this epoch in accepted order, with the kind and parent link the lane retained at acceptance
 * (RULING-61 Q1 = C), so its family is exact whether its text is still the tail's (`source: "tail"`) or the file's
 * (`source: "file"`, read by S11's page route): the recovery owner never reads the session file itself.
 */
interface AncestryRow {
	readonly index: number;
	readonly id: string;
	readonly source: "tail" | "file";
	readonly parentId: string | null;
	readonly kind: string;
	readonly family: string;
}

/**
 * The transcript and opaque families (R4.B2, RULING-60 Q1, RULING-61) from what the frozen S04 root owns: its
 * descriptor, the loaded base as a file range, then one ancestry row per accepted entry of the epoch. An entry whose
 * kind the engine union does not know is also an `opaque` member: its exact retained line while the tail holds it,
 * else its ancestry row naming the file as its source. With a loaded base the opaque family names the base stream
 * too; it is explicitly empty only when its producer is complete and no base exists, and a partial one with no
 * member of this epoch emits nothing. An unavailable root is an explicit descriptor with its typed reason and no rows.
 */
export async function* transcriptComponents(
	store: CompactContentStore,
	transcript: TranscriptRoot,
	producers: FamilyProducers,
	valid: () => void,
): AsyncGenerator<CatalogComponent> {
	const descriptor: TranscriptDescriptor = {
		historyVersion: transcript.historyVersion,
		leafId: transcript.leafId,
		count: transcript.count,
		base: transcript.base && { count: transcript.base.count, idFingerprint: transcript.base.idFingerprint },
		persisted: transcript.tail.persistence?.count ?? null,
		unavailable: transcript.unavailable,
	};
	yield* textComponent(store, TRANSCRIPT, TRANSCRIPT, JSON.stringify(descriptor));
	if (transcript.unavailable !== null) return;
	const base = baseRow(transcript);
	if (base !== undefined) yield* textComponent(store, TRANSCRIPT, BASE, base);
	let opaque = 0;
	for (const { index, id, kind, parentId } of transcript.accepted) {
		valid();
		const text = transcript.tail.entries.get(index);
		const family = entryFamily(kind);
		const row: AncestryRow = { index, id, source: text === undefined ? "file" : "tail", parentId, kind, family };
		const line = JSON.stringify(row);
		yield* textComponent(store, TRANSCRIPT, memberId("entry", index), line);
		if (family !== "opaque") continue;
		opaque += 1;
		yield* textComponent(store, OPAQUE, memberId("entry", index), text ?? line);
	}
	if (base !== undefined) yield* textComponent(store, OPAQUE, BASE, base);
	else if (opaque === 0 && producers.opaque === "complete") yield { kind: OPAQUE, id: OPAQUE, leaves: [], owner: 0 };
}

export const textComponent = (
	store: CompactContentStore,
	kind: CatalogComponent["kind"],
	id: CatalogComponent["id"],
	text: string,
): AsyncGenerator<CatalogComponent> => writtenComponent(store, kind, id, (writer) => writer.push(text));
