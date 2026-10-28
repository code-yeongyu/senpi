import { callsComponents } from "./compact-catalog-calls.ts";
import { activeComponents } from "./compact-catalog-messages.ts";
import {
	assertCoverage,
	CATALOG_FAMILIES,
	type CatalogFamily,
	familyId,
	familyProducers,
	familyRegistry,
	memberId,
} from "./compact-catalog-registry.ts";
import { identityComponents, settledComponents } from "./compact-catalog-settled.ts";
import { sourceComponents } from "./compact-catalog-source.ts";
import type { CatalogReader } from "./compact-catalog-steps.ts";
import { textComponent, transcriptComponents } from "./compact-catalog-transcript.ts";
import { emptyComponent, stepsComponent } from "./compact-catalog-writer.ts";
import { CompactComponentRoots } from "./compact-component-roots.ts";
import type { CompactContentStore } from "./compact-content-store.ts";
import type { CompactDialog } from "./compact-current-components.ts";
import { CompactReadError } from "./compact-read-lease.ts";
import type { CatalogComponent } from "./compact-recovery-catalog.ts";
import { protocolId } from "./compact-recovery-ids.ts";
import type { SettledReader } from "./compact-settled-messages.ts";
import type { CompactValues, ValueRef } from "./compact-values.ts";
import type { FrozenAcceptedRoot } from "./session-acceptance-lane.ts";

const FAMILIES = protocolId("families");
const RUN = familyId("run");
const LIFECYCLE = familyId("lifecycle");
const DIALOGS = familyId("dialogs");

/** One frozen cut as its catalog reads it: the current store, a value reader over it, the root, the settled reader. */
interface CatalogCut {
	readonly store: CompactContentStore;
	readonly values: CompactValues;
	readonly root: FrozenAcceptedRoot;
	readonly settled: SettledReader;
}

/**
 * Every component of one frozen root, in schema order (R4.B2): the family registry, then each family's members or
 * its explicit empty component. A family with a complete producer is never omitted, and a `partial` one emits only
 * the members it enumerated and never an explicit empty, so a reader can tell "no members" from "not enumerated"
 * (RULING-60 Q1, RULING-61 Q1). Members stream one at a time: a value goes through `walk` into bounded leaves, a
 * collection through `rows`, and each component's leaves are released once the catalog has placed it. The
 * completeness gate runs last: a complete producer that emitted nothing refuses the whole catalog (X03).
 */
export async function* checkpointComponents(cut: CatalogCut, valid: () => void): AsyncGenerator<CatalogComponent> {
	const { store, values, root, settled } = cut;
	const current = root.current;
	if (!current) throw new CompactReadError("unavailable");
	const reader: CatalogReader = { store, values, valid };
	const producers = familyProducers(root.transcript);
	const registry = familyRegistry(producers);
	yield* textComponent(store, FAMILIES, FAMILIES, JSON.stringify(registry));
	const family = (name: CatalogFamily): AsyncGenerator<CatalogComponent> => {
		switch (name) {
			case "transcript":
				return transcriptComponents(store, root.transcript, producers, valid);
			case "opaque":
				return none();
			case "run": {
				const { runState, dialogCounts } = current.components;
				return textComponent(store, RUN, RUN, JSON.stringify({ runState, dialogCounts }));
			}
			case "lifecycle": {
				const ref = current.components.lifecycle;
				return ref ? stepsComponent(store, LIFECYCLE, LIFECYCLE, values.walk(ref, valid)) : one(name);
			}
			case "dialogs":
				return dialogComponents(reader, current.components.dialogs);
			case "active":
				return activeComponents(reader, current.active);
			case "calls":
				return callsComponents(reader, current.calls);
			case "settled":
				return settledComponents(reader, settled);
			case "identity":
				return identityComponents(reader, root, settled);
			case "source":
				return sourceComponents(reader, root.transcript, producers, settled);
			default:
				return assertNever(name);
		}
	};
	const emitted = new Set<string>();
	for (const name of CATALOG_FAMILIES)
		for await (const component of family(name)) {
			emitted.add(component.kind);
			yield component;
		}
	assertCoverage(registry, emitted);
}

async function* dialogComponents(reader: CatalogReader, ref: ValueRef | undefined): AsyncGenerator<CatalogComponent> {
	const dialogs = new CompactComponentRoots<CompactDialog>(reader.store, () => []);
	let count = 0;
	for await (const [order, value] of dialogs.rows(ref, reader.valid)) {
		const steps = reader.values.walk(value, reader.valid);
		yield* stepsComponent(reader.store, DIALOGS, memberId("dialog", Number(order)), steps);
		count += 1;
	}
	if (count === 0) yield emptyComponent("dialogs");
}

/** The opaque family's members are emitted by the transcript adapter beside their ancestry rows. */
async function* none(): AsyncGenerator<CatalogComponent> {}

async function* one(family: CatalogFamily): AsyncGenerator<CatalogComponent> {
	yield emptyComponent(family);
}

function assertNever(family: never): never {
	throw new Error(`unmapped catalog family: ${JSON.stringify(family)}`);
}
