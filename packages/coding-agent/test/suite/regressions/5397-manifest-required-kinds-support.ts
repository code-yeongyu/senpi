import { expect } from "vitest";
import { CATALOG_FAMILIES, readFamilyRegistry } from "../../../src/modes/rpc/compact-catalog-registry.ts";
import type { RecoveryRoute } from "../../../src/modes/rpc/compact-recovery-state.ts";
import type { RecoveryOutcome } from "../../../src/modes/rpc/compact-recovery-types.ts";
import { component, componentText } from "./4272-frozen-bytes-support.ts";
import type { RecoveryRig } from "./4272-recovery-support.ts";

const caller = { socketEpoch: "socket-1", sessionId: "s" };
const route: RecoveryRoute = {
	socketEpoch: "socket-1",
	admissionId: "attach-1",
	routeKind: "ordinary",
	peer: "peer",
	sessionId: "s",
};

function unwrap<T>(outcome: RecoveryOutcome<T>): T {
	if (!outcome.ok) throw new Error(`refused: ${JSON.stringify(outcome.failure)}`);
	return outcome.value;
}

/** Families in code-unit order: the order RULING-128 fixes for `requiredKinds`, restated here, not taken from the engine. */
export const sortedFamilies = (families: readonly string[]): string[] =>
	[...families].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/** A correlated record nested past the protocol depth limit: the cut's identity family becomes partial (RULING-67 (4)). */
export function refuseOneCorrelation(rig: RecoveryRig): void {
	let deep: unknown = "leaf";
	for (let depth = 0; depth < 1_100; depth++) deep = [deep];
	rig.lane.accept(
		{ type: "message_end", clientMessageId: "c2", message: { role: "custom", content: deep, timestamp: 1 } },
		undefined,
	);
}

/**
 * One fresh cut through the manifest path: its manifest, the root node it names, and the `families/families` component
 * read through the digest-verified catalog route, with the families its registry marks `complete`.
 */
export async function manifestCut(rig: RecoveryRig) {
	await rig.lane.idle();
	const token = unwrap(rig.checkpoints.freeze(route, rig.lane)).token;
	const manifest = unwrap(await rig.checkpoints.catalog(token, caller));
	const root = unwrap(await rig.checkpoints.readCatalog(token, caller, manifest.catalogRoot));
	if (root.kind !== "node") throw new Error("the catalog root is not a node");
	const index = root.entries.findIndex((entry) => entry.kind === "families" && entry.id === "families");
	expect(index, "the registry is a root entry").toBeGreaterThanOrEqual(0);
	const ref = `${manifest.catalogRoot}:${String(index).padStart(3, "0")}`;
	const families = component(unwrap(await rig.checkpoints.readCatalog(token, caller, ref)));
	const familiesText = await componentText(families);
	const registry = readFamilyRegistry(familiesText);
	const complete = registry.families.filter(({ producer }) => producer === "complete").map(({ family }) => family);
	expect(complete.every((family) => CATALOG_FAMILIES.includes(family))).toBe(true);
	const release = async () => {
		rig.checkpoints.release(token);
		await rig.lane.idle();
	};
	return { manifest, root, entry: families.entry, familiesText, registry, complete, release };
}
