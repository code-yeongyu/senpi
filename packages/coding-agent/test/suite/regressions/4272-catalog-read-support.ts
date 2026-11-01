import { expect } from "vitest";
import { checkpointComponents } from "../../../src/modes/rpc/compact-catalog-families.ts";
import type { CatalogRead } from "../../../src/modes/rpc/compact-recovery-catalog.ts";
import type { RecoveryRoute } from "../../../src/modes/rpc/compact-recovery-state.ts";
import type { RecoveryOutcome } from "../../../src/modes/rpc/compact-recovery-types.ts";
import { CompactValues } from "../../../src/modes/rpc/compact-values.ts";
import type { FrozenAcceptedRoot, SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import type { RecoveryRig } from "./4272-recovery-support.ts";

const caller = { socketEpoch: "socket-1", sessionId: "s" };
const route = (): RecoveryRoute => ({
	socketEpoch: "socket-1",
	admissionId: "attach-1",
	routeKind: "ordinary",
	peer: "peer",
	sessionId: "s",
});

function unwrap<T>(outcome: RecoveryOutcome<T>): T {
	if (!outcome.ok) throw new Error(`refused: ${JSON.stringify(outcome.failure)}`);
	return outcome.value;
}
const node = (read: CatalogRead) => (read.kind === "node" ? read : expect.unreachable("expected a node"));
const component = (read: CatalogRead) =>
	read.kind === "component" ? read : expect.unreachable("expected a component");
const ref = (root: string, index: number) => `${root}:${String(index).padStart(3, "0")}`;

export const entryMember = (index: number) => `entry-${String(index).padStart(16, "0")}`;

/**
 * The rig's catalog of one fresh cut: the root node's entries as `[kind, id]`, a component-text reader, its token.
 * `afterFreeze` runs between the cut and its catalog build, so a test can change the lane under a frozen root.
 */
export async function catalogOf(rig: RecoveryRig, afterFreeze?: () => void) {
	await rig.lane.idle();
	const token = unwrap(rig.checkpoints.freeze(route(), rig.lane)).token;
	afterFreeze?.();
	const manifest = unwrap(await rig.checkpoints.catalog(token, caller));
	const root = node(unwrap(await rig.checkpoints.readCatalog(token, caller, manifest.catalogRoot)));
	const entries = root.entries.map((entry) => [entry.kind, entry.id] as const);
	const text = async (kind: string, id: string) => {
		const index = entries.findIndex(([k, i]) => k === kind && i === id);
		expect(index, `${kind}/${id} is cataloged`).toBeGreaterThanOrEqual(0);
		return component(unwrap(await rig.checkpoints.readCatalog(token, caller, ref(manifest.catalogRoot, index))));
	};
	const json = async (kind: string, id: string): Promise<unknown> => JSON.parse((await text(kind, id)).text);
	const release = () => {
		rig.checkpoints.release(token);
		expect(rig.lane.liveRoots).toBe(0);
	};
	return { entries, text, json, release };
}

export const memberOf = (prefix: string, ordinal: number) => `${prefix}-${String(ordinal).padStart(16, "0")}`;

/** Every component of one cut straight from the producer: `kind/id` -> text, with the value reader's page peak. */
export async function produced(lane: SessionAcceptanceLane, root: FrozenAcceptedRoot) {
	return lane.cutStorage(root, async (store, valid) => {
		const values = new CompactValues(store);
		const texts = new Map<string, string>();
		for await (const part of checkpointComponents({ store, values, root, settled: lane.settledOf(root) }, valid)) {
			const chunks: string[] = [];
			for (const leaf of part.leaves) chunks.push(await store.readLeaf(leaf));
			texts.set(`${part.kind}/${part.id}`, chunks.join(""));
		}
		return { texts, peak: values.peakResidentPages };
	});
}
