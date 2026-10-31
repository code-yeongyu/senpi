import type { CatalogComponent } from "./compact-recovery-catalog.ts";
import { type BoundedId, protocolId } from "./compact-recovery-ids.ts";
import type { FrozenCompactState } from "./compact-state-view.ts";
import type { ValueRef } from "./compact-values.ts";
import type { FrozenAcceptedRoot } from "./session-acceptance-lane.ts";

/**
 * The component families S09 catalogs from a frozen root: the persistent root of each current-state collection
 * (R4.B1). S10 extends this adapter to every member and index (R4.B2); an absent collection is an explicit empty
 * component, never an omission.
 */
const FAMILIES = ["lifecycle", "dialogs", "active", "calls", "settled"] as const;
type Family = (typeof FAMILIES)[number];
const IDS: Readonly<Record<Family, BoundedId>> = {
	lifecycle: protocolId("lifecycle"),
	dialogs: protocolId("dialogs"),
	active: protocolId("active"),
	calls: protocolId("calls"),
	settled: protocolId("settled"),
};

const rootsOf = (current: FrozenCompactState): Readonly<Record<Family, ValueRef | undefined>> => ({
	lifecycle: current.components.lifecycle,
	dialogs: current.components.dialogs,
	active: current.active,
	calls: current.calls.ref,
	settled: current.settled.base?.ref,
});

export function* checkpointComponents(root: FrozenAcceptedRoot): Generator<CatalogComponent> {
	if (!root.current) return;
	const roots = rootsOf(root.current);
	for (const family of FAMILIES) {
		const ref = roots[family];
		const id = IDS[family];
		yield ref && ref.node > 0
			? { kind: id, id, leaves: [ref.node], owner: ref.owner }
			: { kind: id, id, leaves: [], owner: 0 };
	}
}
