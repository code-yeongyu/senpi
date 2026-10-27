import { expect } from "vitest";
import type { CatalogRead } from "../../../src/modes/rpc/compact-recovery-catalog.ts";
import type { RecoveryRoute } from "../../../src/modes/rpc/compact-recovery-state.ts";
import type { RecoveryOutcome } from "../../../src/modes/rpc/compact-recovery-types.ts";
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

/** The rig's catalog of one fresh cut: the root node's entries as `[kind, id]`, a component-text reader, its token. */
export async function catalogOf(rig: RecoveryRig) {
	await rig.lane.idle();
	const token = unwrap(rig.checkpoints.freeze(route(), rig.lane)).token;
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
