import { readdir, stat, truncate, unlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COMPACT_LEAF_CODE_UNITS as LEAF } from "../../src/modes/rpc/compact-content-store.ts";
import { CompactSessionState, type CompactSessionStateOptions } from "../../src/modes/rpc/compact-session-state.ts";
import { controlledIo, spoolRoot } from "./compact-storage-support.ts";

// senpi#4272 (R3.C6.4 / R3.C2.4, ruling 08): storage contracts of the compact current-state owner.
// Every asynchronous step is driven by an explicit I/O hold, never by elapsed time.

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(options: Partial<CompactSessionStateOptions> = {}) {
	const root = await spoolRoot();
	cleanups.push(root.cleanup);
	const control = controlledIo();
	const state = new CompactSessionState({ dir: root.dir, io: control.io, ...options });
	return { state, control, dir: root.dir };
}

async function current(state: CompactSessionState) {
	const cut = state.freeze();
	try {
		return await state.read(cut);
	} finally {
		state.release(cut);
	}
}

/** Spilled leaf files only; the spool also holds the store's ownership marker. */
async function spoolFiles(dir: string): Promise<string[]> {
	return (await readdir(dir)).filter((name) => name.startsWith("leaf-")).sort();
}

function start(messageId: string, seed: string) {
	return { type: "block_start", messageId, contentIndex: 0, kind: "text", seed, coveredCodeUnits: 0 } as const;
}

describe("compact content store: accepted bytes stay resident until the spill commits", () => {
	it("charges a held write as pending, keeps the RAM copy, and a cut pinned before a reset still reads the old value", async () => {
		const { state, control } = await setup({ spillAboveBytes: 0, spillTargetBytes: 0 });
		const write = control.hold("write");
		state.accept(start("m1", "a".repeat(LEAF)));
		await write.entered;
		expect(state.storageStatus()).toMatchObject({
			residentPayloadBytes: 65_536,
			pendingIoCopyBytes: 65_536,
			spilledLiveBytes: 0,
		});

		const cut = state.freeze();
		state.accept({ type: "block_replace", messageId: "m1", contentIndex: 0, text: "b".repeat(10) });
		expect(state.storageStatus().pinnedOnlyBytes).toBe(65_536);
		write.release();
		await state.idle();

		expect((await current(state)).messages[0].blocks[0].text).toBe("b".repeat(10));
		expect((await state.read(cut)).messages[0].blocks[0].text).toBe("a".repeat(LEAF));
		state.release(cut);
		await state.idle();
		expect(state.storageStatus()).toMatchObject({ pinnedOnlyBytes: 0, pendingIoCopyBytes: 0, reclaimDebtBytes: 0 });
	});

	it("reclaims a write that completes after its leaf was replaced instead of publishing it", async () => {
		const { state, control, dir } = await setup({ spillAboveBytes: 0, spillTargetBytes: 0 });
		const write = control.hold("write");
		state.accept(start("m1", "a".repeat(LEAF)));
		const stalePath = await write.entered;
		state.accept({ type: "block_replace", messageId: "m1", contentIndex: 0, text: "c" });
		expect(state.storageStatus().residentPayloadBytes).toBe(0);
		write.release();
		await state.idle();

		expect(await spoolFiles(dir)).not.toContain(stalePath.slice(dir.length + 1));
		expect(state.storageStatus()).toMatchObject({ spilledLiveBytes: 0, reclaimDebtBytes: 0 });
		expect((await current(state)).messages[0].blocks[0].text).toBe("c");
	});
});

describe("compact content store: failure accounting (ruling 08 conditions 1, 3, 4)", () => {
	it("keeps a failed spill resident, names it in the diagnostic, halts spilling, and never flips persistence", async () => {
		const { state, control, dir } = await setup({ spillAboveBytes: 0, spillTargetBytes: 0 });
		const write = control.hold("write");
		state.accept(start("m1", "x".repeat(LEAF)));
		state.accept({ type: "message_status", messageId: "m1", persistence: "pending" });
		const path = await write.entered;
		write.fail(new Error("EIO: injected spool write failure"));
		await state.idle();

		state.accept(start("m2", "y".repeat(LEAF)));
		await state.idle();
		expect(state.storageStatus()).toMatchObject({
			spillHalted: true,
			residentPayloadBytes: 131_072,
			spillFailureRetainedBytes: 131_072,
			spilledLiveBytes: 0,
			spillBytesWritten: 0,
			failures: [
				{
					operation: "spill_write",
					path,
					cause: "EIO: injected spool write failure",
					retainedInMemoryBytes: 65_536,
				},
			],
		});
		expect(await spoolFiles(dir)).toEqual([]);

		const view = await current(state);
		expect(view.messages.find((m) => m.messageId === "m1")).toEqual({
			messageId: "m1",
			persistence: "pending",
			blocks: [{ contentIndex: 0, kind: "text", text: "x".repeat(LEAF) }],
		});
		state.accept({ type: "message_status", messageId: "m1", persistence: "appended" });
		expect((await current(state)).messages.find((m) => m.messageId === "m1")?.persistence).toBe("appended");
	});

	it("rejects a read of a deleted or truncated committed leaf with the storage error, never empty content", async () => {
		const { state, dir } = await setup({ spillAboveBytes: 0, spillTargetBytes: 0 });
		state.accept(start("m1", "q".repeat(LEAF)));
		state.accept(start("m2", "r".repeat(LEAF)));
		await state.idle();
		const [first, second] = await spoolFiles(dir);
		expect(state.storageStatus().spilledLiveBytes).toBe(131_072);

		await unlink(join(dir, first));
		const deleted = state.freeze();
		await expect(state.read(deleted)).rejects.toMatchObject({
			name: "CompactStorageReadError",
			operation: "leaf_read",
			cause: { code: "ENOENT" },
		});
		state.release(deleted);

		await truncate(join(dir, second), 100);
		state.accept({ type: "message_remove", messageId: "m1" });
		const truncated = state.freeze();
		await expect(state.read(truncated)).rejects.toThrow("expected 65536 bytes, found 100");
		state.release(truncated);
	});
});

describe("compact content index: coalesced overrides and stale compaction", () => {
	it("never lets an old compaction erase a newer override or resurrect a removed row", async () => {
		const { state, control } = await setup({ compactAboveRows: 3 });
		for (const id of ["m1", "m2", "m3"]) state.accept(start(id, ""));
		const pageWrite = control.hold("write");
		for (const id of ["m1", "m2", "m3"])
			state.accept({ type: "message_status", messageId: id, persistence: "pending" });
		await pageWrite.entered;

		const before = state.freeze();
		state.accept({ type: "message_status", messageId: "m1", persistence: "appended" });
		state.accept({ type: "message_remove", messageId: "m2" });
		pageWrite.release();
		await state.idle();

		expect(state.storageStatus()).toMatchObject({ basePages: 1, baseRows: 1, overrideSlots: 1, deletionMasks: 0 });
		const persistence = async (cut = state.freeze()) => {
			const view = await state.read(cut);
			state.release(cut);
			return Object.fromEntries(view.messages.map((m) => [m.messageId, m.persistence]));
		};
		expect(await persistence()).toEqual({ m1: "appended", m3: "pending" });
		expect(await persistence(before)).toEqual({ m1: "pending", m2: "pending", m3: "pending" });

		for (const id of ["m4", "m5"]) {
			state.accept(start(id, ""));
			state.accept({ type: "message_status", messageId: id, persistence: "failed" });
		}
		await state.idle();
		expect(state.storageStatus()).toMatchObject({
			overrideSlots: 0,
			deletionMasks: 0,
			baseRows: 4,
			reclaimDebtBytes: 0,
		});
		expect(await persistence()).toEqual({ m1: "appended", m3: "pending", m4: "failed", m5: "failed" });
	});
});

describe("compact session state: exact settled-row transitions", () => {
	it("replaces and removes spilled settled rows exactly and refuses transitions on a removed message", async () => {
		const { state, dir } = await setup({ spillAboveBytes: 0, spillTargetBytes: 0 });
		for (const id of ["m1", "m2", "m3"]) {
			state.accept(start(id, id.repeat(LEAF / 2)));
			state.accept({ type: "message_status", messageId: id, persistence: "pending" });
		}
		await state.idle();
		expect(state.storageStatus()).toMatchObject({ residentPayloadBytes: 0, overrideSlots: 3 });

		const before = state.freeze();
		state.accept({ type: "message_status", messageId: "m1", persistence: "appended" });
		state.accept({ type: "message_remove", messageId: "m2" });
		const sequence = state.acceptedSequence;
		const status = state.storageStatus();
		for (const transition of [
			{ type: "message_status", messageId: "m2", persistence: "appended" },
			{ type: "message_remove", messageId: "m2" },
			{ type: "message_status", messageId: "never", persistence: "failed" },
		] as const) {
			expect(() => state.accept(transition)).toThrow(
				expect.objectContaining({ name: "CompactTransitionError", reason: "unknown_message" }),
			);
		}
		expect(state.acceptedSequence).toBe(sequence);
		expect(state.storageStatus()).toEqual(status);

		const persistence = async (cut = state.freeze()) => {
			const view = await state.read(cut);
			state.release(cut);
			return Object.fromEntries(view.messages.map((m) => [m.messageId, [m.persistence, m.blocks[0]?.text.length]]));
		};
		expect(await persistence()).toEqual({ m1: ["appended", LEAF], m3: ["pending", LEAF] });
		expect(await persistence(before)).toEqual({
			m1: ["pending", LEAF],
			m2: ["pending", LEAF],
			m3: ["pending", LEAF],
		});
		await state.idle();
		expect(await spoolFiles(dir)).toHaveLength(2);

		state.accept(start("m2", "new"));
		state.accept({ type: "message_status", messageId: "m2", persistence: "failed" });
		expect((await current(state)).messages.find((m) => m.messageId === "m2")).toEqual({
			messageId: "m2",
			persistence: "failed",
			blocks: [{ contentIndex: 0, kind: "text", text: "new" }],
		});
		expect(state.storageStatus()).toMatchObject({ overrideSlots: 3, deletionMasks: 0, reclaimDebtBytes: 0 });
	});

	it("holds one override slot for 10,000 updates to the same settled row", async () => {
		const { state } = await setup();
		state.accept(start("m1", "abc"));
		state.accept({ type: "message_status", messageId: "m1", persistence: "pending" });
		const resident = state.storageStatus().residentPayloadBytes;
		for (let i = 0; i < 10_000; i++) {
			state.accept({ type: "message_status", messageId: "m1", persistence: i % 2 === 0 ? "appended" : "failed" });
		}
		expect(state.acceptedSequence).toBe(10_002);
		expect(state.storageStatus()).toMatchObject({ overrideSlots: 1, residentPayloadBytes: resident });
		expect((await current(state)).messages).toEqual([
			{ messageId: "m1", persistence: "failed", blocks: [{ contentIndex: 0, kind: "text", text: "abc" }] },
		]);
	});
});

describe("compact content store: reclamation and retirement (ruling 08 condition 5)", () => {
	it("counts removed committed content as debt until quiescence releases it", async () => {
		const { state, control, dir } = await setup({ spillAboveBytes: 0, spillTargetBytes: 0 });
		state.accept(start("m1", "r".repeat(2 * LEAF)));
		state.accept({ type: "message_status", messageId: "m1", persistence: "appended" });
		await state.idle();
		expect(state.storageStatus()).toMatchObject({ spilledLiveBytes: 131_072, reclaimDebtBytes: 0 });

		const firstUnlink = control.hold("unlink");
		state.accept({ type: "message_remove", messageId: "m1" });
		await firstUnlink.entered;
		expect(state.storageStatus()).toMatchObject({ spilledLiveBytes: 0, reclaimDebtBytes: 131_072 });
		firstUnlink.release();
		await state.idle();
		expect(state.storageStatus()).toMatchObject({ spilledLiveBytes: 0, reclaimDebtBytes: 0 });
		expect(await spoolFiles(dir)).toEqual([]);
	});

	it("joins a pending write on retirement and removes only the epoch directory", async () => {
		const { state, control, dir } = await setup({ spillAboveBytes: 0, spillTargetBytes: 0 });
		const write = control.hold("write");
		state.accept(start("m1", "z".repeat(LEAF)));
		await write.entered;
		const retired = state.retire();
		write.release();
		await retired;
		await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await stat(join(dir, "..", ".."))).isDirectory()).toBe(true);
	});
});
