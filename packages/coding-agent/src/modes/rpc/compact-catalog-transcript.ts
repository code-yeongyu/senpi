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
 * The loaded base (entries from before this epoch) as the one file range S11 streams through the captured identity:
 * their kinds were never accepted here, so the transcript and opaque producers are `partial` while this row exists.
 */
interface BaseRow {
	readonly source: "file";
	readonly first: 0;
	readonly count: number;
	readonly idFingerprint: string;
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
 * else its ancestry row naming the file as its source. The opaque family is explicitly empty only when its producer
 * is complete; a partial one with no member of this epoch emits nothing. An unavailable root is an explicit
 * descriptor with its typed reason and no rows.
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
	if (transcript.base && transcript.base.count > 0) {
		const base: BaseRow = {
			source: "file",
			first: 0,
			count: transcript.base.count,
			idFingerprint: transcript.base.idFingerprint,
		};
		yield* textComponent(store, TRANSCRIPT, BASE, JSON.stringify(base));
	}
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
	if (opaque === 0 && producers.opaque === "complete") yield { kind: OPAQUE, id: OPAQUE, leaves: [], owner: 0 };
}

export const textComponent = (
	store: CompactContentStore,
	kind: CatalogComponent["kind"],
	id: CatalogComponent["id"],
	text: string,
): AsyncGenerator<CatalogComponent> => writtenComponent(store, kind, id, (writer) => writer.push(text));
