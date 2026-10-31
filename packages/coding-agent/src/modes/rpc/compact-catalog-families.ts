import {
	CATALOG_FAMILIES,
	type CatalogFamily,
	familyId,
	familyProducers,
	familyRegistry,
	memberId,
} from "./compact-catalog-registry.ts";
import { textComponent, transcriptComponents } from "./compact-catalog-transcript.ts";
import { encodeValueSteps, writtenComponent } from "./compact-catalog-writer.ts";
import { CompactComponentRoots } from "./compact-component-roots.ts";
import type { CompactContentStore } from "./compact-content-store.ts";
import type { CompactDialog } from "./compact-current-components.ts";
import { CompactReadError } from "./compact-read-lease.ts";
import type { CatalogComponent } from "./compact-recovery-catalog.ts";
import { type BoundedId, protocolId } from "./compact-recovery-ids.ts";
import type { FrozenCompactState } from "./compact-state-view.ts";
import type { CompactValues, ValueRef } from "./compact-values.ts";
import type { FrozenAcceptedRoot } from "./session-acceptance-lane.ts";

const FAMILIES = protocolId("families");
const RUN = familyId("run");
const LIFECYCLE = familyId("lifecycle");
const DIALOGS = familyId("dialogs");

const empty = (family: CatalogFamily): CatalogComponent => ({
	kind: familyId(family),
	id: familyId(family),
	leaves: [],
	owner: 0,
});

/** A walked value as one component: canonical JSON streamed into bounded leaves with one value page resident. */
const walked = (
	store: CompactContentStore,
	values: CompactValues,
	kind: BoundedId,
	id: BoundedId,
	ref: ValueRef,
	valid: () => void,
): AsyncGenerator<CatalogComponent> =>
	writtenComponent(store, kind, id, async (writer) => {
		for await (const fragment of encodeValueSteps(values.walk(ref, valid))) writer.push(fragment);
	});

/** The R4.B1 producers (S09): a collection's persistent root leaf; S10b enumerates its members. */
const rootLeaf = (family: "active" | "calls" | "settled", current: FrozenCompactState): CatalogComponent => {
	const ref = { active: current.active, calls: current.calls.ref, settled: current.settled.base?.ref }[family];
	return ref && ref.node > 0
		? { kind: familyId(family), id: familyId(family), leaves: [ref.node], owner: ref.owner }
		: empty(family);
};

/**
 * Every component of one frozen root, in schema order (R4.B2): the family registry, then each family's members or
 * its explicit empty component. A family with a complete producer is never omitted; a `pending` one is never
 * emitted, and a `partial` one emits only the members it enumerated and never an explicit empty, so a reader can
 * tell "no members" from "no producer yet" (RULING-60 Q1, RULING-61 Q1). Members stream one at a time: a value goes
 * through `walk` into bounded leaves, a collection through `rows`, and each component's leaves are released once
 * the catalog has placed it. The producer assembly is incomplete until S10b (the registry's `assembly`).
 */
export async function* checkpointComponents(
	store: CompactContentStore,
	values: CompactValues,
	root: FrozenAcceptedRoot,
	valid: () => void,
): AsyncGenerator<CatalogComponent> {
	const current = root.current;
	if (!current) throw new CompactReadError("unavailable");
	const producers = familyProducers(root.transcript);
	yield* textComponent(store, FAMILIES, FAMILIES, JSON.stringify(familyRegistry(producers)));
	for (const family of CATALOG_FAMILIES) {
		if (producers[family] === "pending") continue;
		switch (family) {
			case "transcript":
				yield* transcriptComponents(store, root.transcript, producers, valid);
				break;
			case "opaque":
				break;
			case "run": {
				const { runState, dialogCounts } = current.components;
				yield* textComponent(store, RUN, RUN, JSON.stringify({ runState, dialogCounts }));
				break;
			}
			case "lifecycle": {
				const ref = current.components.lifecycle;
				if (ref) yield* walked(store, values, LIFECYCLE, LIFECYCLE, ref, valid);
				else yield empty(family);
				break;
			}
			case "dialogs": {
				const dialogs = new CompactComponentRoots<CompactDialog>(store, () => []);
				let count = 0;
				for await (const [order, ref] of dialogs.rows(current.components.dialogs, valid)) {
					yield* walked(store, values, DIALOGS, memberId("dialog", Number(order)), ref, valid);
					count += 1;
				}
				if (count === 0) yield empty(family);
				break;
			}
			case "active":
			case "calls":
			case "settled":
				yield rootLeaf(family, current);
				break;
			case "identity":
			case "source":
				break;
			default:
				return assertNever(family);
		}
	}
}

function assertNever(family: never): never {
	throw new Error(`unmapped catalog family: ${JSON.stringify(family)}`);
}
