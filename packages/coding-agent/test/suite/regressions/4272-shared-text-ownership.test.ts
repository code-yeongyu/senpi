import { afterEach, expect, it } from "vitest";
import { CompactContentIndex } from "../../../src/modes/rpc/compact-content-index.ts";
import { CompactContentStore, type LeafId } from "../../../src/modes/rpc/compact-content-store.ts";
import { CompactSessionState } from "../../../src/modes/rpc/compact-session-state.ts";
import { controlledIo, spoolRoot, startIdentity } from "../compact-storage-support.ts";

// senpi#4272, RULING-26a: a commit belongs to every referencing row and subscriber.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

it("compacts both subscribers and both keys sharing one leaf after a held commit", async () => {
	const root = await spoolRoot();
	cleanups.push(root.cleanup);
	const control = controlledIo();
	const store = new CompactContentStore({ dir: root.dir, io: control.io, spillAboveBytes: 0, spillTargetBytes: 0 });
	const indexes = [0, 1].map(() => new CompactContentIndex<{ refs: LeafId[] }>(store, (row) => row.refs, 2));
	const write = control.hold("write");
	const leaf = store.createLeaf("shared");
	for (const index of indexes) {
		index.set("a", { refs: [leaf, leaf] });
		index.set("b", { refs: [leaf] });
		index.set("removed", { refs: [leaf] });
		index.delete("removed");
	}
	store.adjust(leaf, -1, 0);
	await write.entered;
	write.release();
	await store.idle();
	for (const index of indexes) expect(index.status()).toMatchObject({ baseRows: 2, overrideSlots: 0 });
	const cuts = indexes.map((index) => index.freeze());
	for (const index of indexes) {
		index.delete("a");
		index.delete("b");
	}
	await store.idle();
	indexes[1].release(cuts[1]);
	indexes[1].release(cuts[1]);
	expect(await store.readLeaf(leaf)).toBe("shared");
	indexes[0].release(cuts[0]);
	await store.idle();
	expect(store.status()).toMatchObject({ spilledLiveBytes: 0, reclaimDebtBytes: 0 });
	await store.retire();
});

it("rejects a released consumer cut and makes a second release harmless", async () => {
	const root = await spoolRoot();
	cleanups.push(root.cleanup);
	const state = new CompactSessionState({ dir: root.dir });
	state.accept({
		type: "block_start",
		...startIdentity(),
		messageId: "m",
		contentIndex: 0,
		kind: "text",
		seed: "small tail",
		coveredCodeUnits: 0,
	});
	const cut = state.freeze();
	state.release(cut);
	expect(() => state.release(cut)).not.toThrow();
	await expect(state.read(cut)).rejects.toMatchObject({ name: "CompactReadError", reason: "released" });
	expect(state.storageStatus().frozenTailBytes).toBe(0);
	await state.retire();
});
