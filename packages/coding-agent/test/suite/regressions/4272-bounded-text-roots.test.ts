import { afterEach, expect, it, vi } from "vitest";
import { COMPACT_LEAF_CODE_UNITS as LEAF, CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { CompactSessionState } from "../../../src/modes/rpc/compact-session-state.ts";
import { controlledIo, spoolRoot, startIdentity } from "../compact-storage-support.ts";

// senpi#4272, RULING-26 Q3 / 26a: limits refuse, never truncate, before leaf I/O.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

it("rejects an oversized leaf with a write-side error before changing ownership or accounting", async () => {
	const root = await spoolRoot();
	cleanups.push(root.cleanup);
	const store = new CompactContentStore({ dir: root.dir });
	const ref = store.createLeaf("x".repeat(LEAF));
	try {
		const before = store.status();
		expect(() => store.createLeaf("x".repeat(LEAF + 1))).toThrow(
			expect.objectContaining({ name: "CompactWriteError", reason: "size_limit" }),
		);
		expect(store.status()).toEqual(before);
		expect(await store.readLeaf(ref)).toBe("x".repeat(LEAF));
	} finally {
		store.adjust(ref, -1, 0);
		await store.retire();
	}
});

it("reads exactly the size/count boundary and rejects either excess without reading", async () => {
	const root = await spoolRoot();
	cleanups.push(root.cleanup);
	const control = controlledIo();
	let reads = 0;
	const store = new CompactContentStore({
		dir: root.dir,
		spillAboveBytes: 0,
		spillTargetBytes: 0,
		io: {
			...control.io,
			readFile: (path, range) => {
				reads++;
				return control.io.readFile(path, range);
			},
		},
	});
	let ref = store.text.append(0, "a".repeat(LEAF - 1) + "\uD83D");
	ref = store.text.append(ref, "\uDE00" + "b".repeat(LEAF - 1));
	await store.idle();
	expect(await store.text.read(ref, "", 0, LEAF, 1)).toBe("a".repeat(LEAF - 1) + "\uD83D");
	expect(await store.text.read(ref, "", LEAF - 1, 2, 2)).toBe("\u{1F600}");
	const before = reads;
	await expect(store.text.read(ref, "", 0, LEAF + 1)).rejects.toMatchObject({ reason: "size_limit" });
	await expect(store.text.read(ref, "", LEAF - 1, 2, 1)).rejects.toMatchObject({ reason: "count_limit" });
	await expect(store.text.read(ref, "tail", 2 * LEAF - 1, 2, 1)).rejects.toMatchObject({ reason: "count_limit" });
	for (const count of [0, 3, 1.5, NaN])
		await expect(store.text.read(ref, "", 0, 1, count)).rejects.toMatchObject({ reason: "count_limit" });
	for (const [offset, units] of [
		[-1, 1],
		[0, -1],
		[0.5, 1],
		[0, NaN],
		[2 * LEAF, 1],
	]) {
		await expect(store.text.read(ref, "", offset, units)).rejects.toMatchObject({ reason: "range" });
	}
	expect(reads).toBe(before);
	expect(await store.text.read(ref, "", 2 * LEAF, 0)).toBe("");
	store.adjust(ref, -1, 0);
	await store.idle();
	expect(store.text.residentNodes).toBe(0);
	await expect(store.text.read(ref, "", 0, 1)).rejects.toMatchObject({ reason: "ownership" });
	await store.retire();
});

it("pins a persistent root without walking its unchanged leaves", async () => {
	const root = await spoolRoot();
	cleanups.push(root.cleanup);
	const store = new CompactContentStore({ dir: root.dir, spillAboveBytes: 8 * 1024 * 1024 });
	let ref = 0;
	for (let i = 0; i < 64; i++) ref = store.text.append(ref, "x".repeat(LEAF));
	const adjust = vi.spyOn(store, "adjust");
	store.adjust(ref, 0, 1);
	expect(adjust).toHaveBeenCalledTimes(1);
	adjust.mockRestore();
	const next = store.text.append(ref, "tail");
	expect(await store.text.read(ref, "", 63 * LEAF, LEAF)).toBe("x".repeat(LEAF));
	expect(await store.text.read(next, "", 64 * LEAF, 4)).toBe("tail");
	store.adjust(ref, 0, -1);
	store.adjust(next, -1, 0);
	await store.idle();
	expect(store.text.residentNodes).toBe(0);
	await store.retire();
});

it("keeps two owners across append, replacement and either release order without copying root vectors", async () => {
	for (const reverse of [false, true]) {
		const root = await spoolRoot();
		cleanups.push(root.cleanup);
		const state = new CompactSessionState({ dir: root.dir, spillAboveBytes: 0, spillTargetBytes: 0 });
		const body = "a".repeat(LEAF * 8) + "\uD800";
		state.accept({
			type: "block_start",
			...startIdentity(),
			messageId: "m",
			contentIndex: 0,
			kind: "text",
			seed: body,
			coveredCodeUnits: 0,
		});
		const first = state.freeze();
		const nodes = state.storageStatus().residentTextNodes;
		const second = state.freeze();
		expect(nodes).toBeGreaterThanOrEqual(7);
		expect(state.storageStatus().residentTextNodes).toBe(nodes);
		state.accept({ type: "block_delta", messageId: "m", contentIndex: 0, offset: body.length, text: "next" });
		state.accept({ type: "message_status", messageId: "m", persistence: "pending" });
		await state.idle();
		const settled = state.freeze();
		expect((await state.read(settled)).messages[0].blocks[0].text).toBe(body + "next");
		state.release(settled);
		await state.applyCold({ type: "message_remove", messageId: "m" });
		const [drop, keep] = reverse ? [second, first] : [first, second];
		state.release(drop);
		state.release(drop);
		expect((await state.read(keep)).messages[0].blocks[0].text).toBe(body);
		state.release(keep);
		await state.idle();
		expect(state.storageStatus()).toMatchObject({
			residentTextNodes: 0,
			residentPayloadBytes: 0,
			spilledLiveBytes: 0,
			pinnedOnlyBytes: 0,
			reclaimDebtBytes: 0,
		});
		await state.retire();
	}
});

it("retains an accepted persistent root after a failed spill without publishing a partial index root", async () => {
	const root = await spoolRoot();
	cleanups.push(root.cleanup);
	const control = controlledIo();
	const state = new CompactSessionState({
		dir: root.dir,
		io: control.io,
		spillAboveBytes: 0,
		spillTargetBytes: 0,
		compactAboveRows: 1,
	});
	const held = control.hold("write");
	const body = "q".repeat(LEAF * 3);
	state.accept({
		type: "block_start",
		...startIdentity(),
		messageId: "m",
		contentIndex: 0,
		kind: "text",
		seed: body,
		coveredCodeUnits: 0,
	});
	state.accept({ type: "message_status", messageId: "m", persistence: "pending" });
	await held.entered;
	held.fail(new Error("EIO: held leaf failed"));
	await state.idle();
	const cut = state.freeze();
	expect((await state.read(cut)).messages).toEqual([
		{
			messageId: "m",
			persistence: "pending",
			blocks: [{ contentIndex: 0, kind: "text", text: body }],
		},
	]);
	expect(state.storageStatus()).toMatchObject({
		basePages: 0,
		overrideSlots: 1,
		residentPayloadBytes: body.length * 2,
		spillFailureRetainedBytes: body.length * 2,
		failures: [{ operation: "spill_write", cause: "EIO: held leaf failed", retainedInMemoryBytes: LEAF * 2 }],
	});
	state.release(cut);
	await state.retire();
});
