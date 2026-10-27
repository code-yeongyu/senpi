import type { FileEntry } from "../../core/session-manager.ts";
import { type BoundedId, protocolId } from "./compact-recovery-ids.ts";

/**
 * The versioned checkpoint schema's families (R4.B2, RULING-60 Q1): engine-owned state only. Desktop-only entities
 * (timeline groups, relations, plans, checkpoints) are derived by the desktop from these families, never cataloged
 * here. Membership is fixed by this list; a family the catalog does not emit is a construction error, not "empty".
 */
export const CATALOG_FAMILIES = [
	"transcript",
	"run",
	"lifecycle",
	"dialogs",
	"opaque",
	"active",
	"calls",
	"settled",
	"identity",
	"source",
] as const;
export type CatalogFamily = (typeof CATALOG_FAMILIES)[number];

/**
 * Who produces a family's members: `complete` enumerates every member (S10a), `root` is the R4.B1 persistent root
 * leaf only (members are S10b's), `pending` has no located producer and is never emitted, so it is never declared
 * empty for lack of one. The catalog's assembly is complete only when every family is `complete` (S10b's gate).
 */
type FamilyProducer = "complete" | "root" | "pending";
export const FAMILY_PRODUCERS: Readonly<Record<CatalogFamily, FamilyProducer>> = {
	transcript: "complete",
	run: "complete",
	lifecycle: "complete",
	dialogs: "complete",
	opaque: "complete",
	active: "root",
	calls: "root",
	settled: "root",
	identity: "pending",
	source: "pending",
};

/**
 * Every engine source kind (the session file's entry union) and the family that owns its data. The compiler refuses
 * a kind this map misses (TS2741), so a new engine entry type cannot ship uncataloged. A kind outside the union at
 * run time (an extension's own entry type) is `opaque`: kept whole, never dropped (RULING-60 Q1 (2)).
 */
type EngineEntryKind = FileEntry["type"];
export const ENTRY_FAMILIES: Readonly<Record<EngineEntryKind, CatalogFamily>> = {
	session: "transcript",
	message: "transcript",
	thinking_level_change: "source",
	configuration_update: "source",
	model_change: "source",
	model_change_rejected: "source",
	usage: "source",
	compaction: "source",
	branch_summary: "source",
	custom: "source",
	custom_message: "source",
	context_edit: "source",
	label: "source",
	session_info: "source",
};
const KNOWN_KINDS: ReadonlyMap<string, CatalogFamily> = new Map(Object.entries(ENTRY_FAMILIES));

export const entryFamily = (kind: string): CatalogFamily => KNOWN_KINDS.get(kind) ?? "opaque";

export const familyId = (family: CatalogFamily): BoundedId => protocolId(family);

/** One member of a family: a fixed-width ordinal, so an arbitrary entry id or key never becomes a catalog id. */
export const memberId = (prefix: "entry" | "dialog", ordinal: number): BoundedId =>
	protocolId(`${prefix}-${String(ordinal).padStart(16, "0")}`);

interface FamilyRegistry {
	readonly format: "senpi-recovery-families";
	readonly version: 1;
	readonly assembly: "incomplete" | "complete";
	readonly families: readonly { readonly family: CatalogFamily; readonly producer: FamilyProducer }[];
}

/** The registry component's value: the schema as this build produces it, with the assembly state S10b completes. */
export function familyRegistry(): FamilyRegistry {
	const families = CATALOG_FAMILIES.map((family) => ({ family, producer: FAMILY_PRODUCERS[family] }));
	return {
		format: "senpi-recovery-families",
		version: 1,
		assembly: families.every(({ producer }) => producer === "complete") ? "complete" : "incomplete",
		families,
	};
}
