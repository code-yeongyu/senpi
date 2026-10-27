import type { TranscriptRoot } from "./accepted-transcript.ts";
import { entryFamily, familyId, memberId } from "./compact-catalog-registry.ts";
import { writtenComponent } from "./compact-catalog-writer.ts";
import type { CompactContentStore } from "./compact-content-store.ts";
import type { CatalogComponent } from "./compact-recovery-catalog.ts";

const TRANSCRIPT = familyId("transcript");
const OPAQUE = familyId("opaque");

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
 * One accepted entry of this epoch in accepted order. Its text is the tail's (`source: "tail"`) until persistence
 * covers it, and then the file's (`source: "file"`), read by S11's page route through the captured base identity:
 * the recovery owner never reads the session file itself (RULING-50 (3)), so ancestry and kind are cataloged
 * exactly for the entries the root still holds.
 */
type AncestryRow =
	| {
			readonly index: number;
			readonly id: string;
			readonly source: "tail";
			readonly parentId: string | null;
			readonly kind: string;
			readonly family: string;
	  }
	| { readonly index: number; readonly id: string; readonly source: "file" };

const field = (entry: object, key: string): unknown => Reflect.get(entry, key);
const stringOr = <T>(value: unknown, fallback: T): string | T => (typeof value === "string" ? value : fallback);

/**
 * The transcript and opaque families (R4.B2, RULING-60 Q1) from what the frozen S04 root owns: its descriptor, then
 * one ancestry row per accepted entry. A retained entry names its engine kind's family; one whose kind the engine
 * union does not know is also kept whole under `opaque`, never dropped. An unavailable root is an explicit
 * descriptor with its typed reason and no rows.
 */
export async function* transcriptComponents(
	store: CompactContentStore,
	transcript: TranscriptRoot,
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
	let opaque = 0;
	if (transcript.unavailable === null)
		for (const [index, id] of transcript.entryIds.entries()) {
			valid();
			const text = transcript.tail.entries.get(index);
			const entry: unknown = text === undefined ? undefined : JSON.parse(text);
			if (typeof entry !== "object" || entry === null || text === undefined) {
				yield* textComponent(
					store,
					TRANSCRIPT,
					memberId("entry", index),
					JSON.stringify({ index, id, source: "file" }),
				);
				continue;
			}
			const kind = stringOr(field(entry, "type"), "");
			const family = entryFamily(kind);
			const row: AncestryRow = {
				index,
				id,
				source: "tail",
				parentId: stringOr(field(entry, "parentId"), null),
				kind,
				family,
			};
			yield* textComponent(store, TRANSCRIPT, memberId("entry", index), JSON.stringify(row));
			if (family !== "opaque") continue;
			opaque += 1;
			yield* textComponent(store, OPAQUE, memberId("entry", index), text);
		}
	if (opaque === 0) yield { kind: OPAQUE, id: OPAQUE, leaves: [], owner: 0 };
}

export const textComponent = (
	store: CompactContentStore,
	kind: CatalogComponent["kind"],
	id: CatalogComponent["id"],
	text: string,
): AsyncGenerator<CatalogComponent> => writtenComponent(store, kind, id, (writer) => writer.push(text));
