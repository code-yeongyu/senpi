import type { FileEntry } from "../../core/session-manager.ts";
import type { TranscriptRoot } from "./accepted-transcript.ts";
import { CompactReadError } from "./compact-read-lease.ts";
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
const FAMILY_SET: ReadonlySet<string> = new Set(CATALOG_FAMILIES);

/**
 * Who produces a family's members: `complete` enumerates every member, `partial` enumerates some and never declares
 * the rest absent (the loaded base S11 streams: its transcript, opaque and source members). The assembly is complete
 * only when every family is `complete`, and a complete producer that emitted nothing fails the gate (`assertCoverage`).
 */
const PRODUCERS = ["complete", "partial"] as const;
type FamilyProducer = (typeof PRODUCERS)[number];
const PRODUCER_SET: ReadonlySet<string> = new Set(PRODUCERS);
export type FamilyProducers = Readonly<Record<CatalogFamily, FamilyProducer>>;

/** What this build's producers reach for a root with no loaded base; `familyProducers` narrows it per root. */
export const FAMILY_PRODUCERS: FamilyProducers = {
	transcript: "complete",
	run: "complete",
	lifecycle: "complete",
	dialogs: "complete",
	opaque: "complete",
	active: "complete",
	calls: "complete",
	settled: "complete",
	identity: "complete",
	source: "complete",
};

/**
 * The producers at one root (RULING-61 Q1): a loaded base is a file range whose kinds this epoch never saw, and an
 * unavailable transcript enumerates nothing, so the families fed by entry kinds (transcript, opaque, source) are
 * then `partial`, never complete or empty.
 */
export function familyProducers(transcript: TranscriptRoot): FamilyProducers {
	const exact = transcript.unavailable === null && (transcript.base?.count ?? 0) === 0;
	return exact
		? FAMILY_PRODUCERS
		: { ...FAMILY_PRODUCERS, transcript: "partial", opaque: "partial", source: "partial" };
}

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
export const memberId = (
	prefix: "entry" | "dialog" | "message" | "call" | "join",
	ordinal: number | string,
): BoundedId => protocolId(`${prefix}-${typeof ordinal === "number" ? String(ordinal).padStart(16, "0") : ordinal}`);

interface FamilyRow {
	readonly family: CatalogFamily;
	readonly producer: FamilyProducer;
}
interface RegistryBase {
	readonly format: "senpi-recovery-families";
	readonly version: 1;
	readonly families: readonly FamilyRow[];
}
export interface CompleteFamilyRegistry extends RegistryBase {
	readonly assembly: "complete";
}
interface IncompleteFamilyRegistry extends RegistryBase {
	readonly assembly: "incomplete";
	/** The families a consumer cannot treat as enumerated: every one whose producer is not `complete`. */
	readonly incomplete: readonly CatalogFamily[];
}
/** The registry every consumer receives (RULING-61 Q3): the assembly state is the discriminant, never a side flag. */
export type FamilyRegistry = CompleteFamilyRegistry | IncompleteFamilyRegistry;

/** The registry component's value for one root: the schema as its producers stand, with the assembly state. */
export function familyRegistry(producers: FamilyProducers): FamilyRegistry {
	const families = CATALOG_FAMILIES.map((family): FamilyRow => ({ family, producer: producers[family] }));
	const incomplete = families.filter(({ producer }) => producer !== "complete").map(({ family }) => family);
	const base = { format: "senpi-recovery-families", version: 1, families } as const;
	return incomplete.length === 0 ? { ...base, assembly: "complete" } : { ...base, assembly: "incomplete", incomplete };
}

/** A registry that is complete only when every producer is; an incomplete one needs the consumer's own check. */
export const completeAssembly = (registry: FamilyRegistry): CompleteFamilyRegistry | undefined =>
	registry.assembly === "complete" ? registry : undefined;

/**
 * The completeness gate (X03): every family whose producer is `complete` must have emitted at least one component,
 * an explicit empty included; a missing one is a construction error that refuses the whole catalog, never a
 * registry that claims more than its components hold. A `partial` family may emit nothing.
 */
export function assertCoverage(registry: FamilyRegistry, emitted: ReadonlySet<string>): void {
	const missing = registry.families.filter(({ family, producer }) => producer === "complete" && !emitted.has(family));
	if (missing.length > 0) throw new CompactReadError("unavailable");
}

const field = (value: object, key: string): unknown => Reflect.get(value, key);
const isFamily = (value: unknown): value is CatalogFamily => typeof value === "string" && FAMILY_SET.has(value);
const isProducer = (value: unknown): value is FamilyProducer => typeof value === "string" && PRODUCER_SET.has(value);

function parseRows(value: unknown): readonly FamilyRow[] | undefined {
	if (!Array.isArray(value) || value.length !== CATALOG_FAMILIES.length) return undefined;
	const rows: FamilyRow[] = [];
	for (const [index, row] of value.entries()) {
		if (typeof row !== "object" || row === null) return undefined;
		const family = field(row, "family");
		const producer = field(row, "producer");
		if (!isFamily(family) || family !== CATALOG_FAMILIES[index] || !isProducer(producer)) return undefined;
		rows.push({ family, producer });
	}
	return rows;
}

/**
 * The one decoder of a `families/families` component (RULING-61 Q3): a consumer gets the discriminated registry or
 * a refusal, never a registry whose assembly state disagrees with its rows.
 */
export function readFamilyRegistry(text: string): FamilyRegistry {
	const value: unknown = JSON.parse(text);
	if (typeof value !== "object" || value === null) throw new RangeError("not a family registry");
	const rows = parseRows(field(value, "families"));
	if (!rows || field(value, "format") !== "senpi-recovery-families" || field(value, "version") !== 1)
		throw new RangeError("not a family registry");
	const producers = Object.fromEntries(rows.map(({ family, producer }) => [family, producer]));
	const registry = familyRegistry({ ...FAMILY_PRODUCERS, ...producers });
	if (field(value, "assembly") !== registry.assembly) throw new RangeError("family registry assembly mismatch");
	return registry;
}
