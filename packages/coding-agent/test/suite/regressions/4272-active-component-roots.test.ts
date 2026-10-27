import { expect, it, vi } from "vitest";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { CompactSessionState } from "../../../src/modes/rpc/compact-session-state.ts";
import { spoolRoot } from "../compact-storage-support.ts";

// senpi#4272 / RULING-38: freeze and settlement transfer roots, not every block.
it("freezes and settles a large active collection with bounded ownership work", async () => {
	const root = await spoolRoot();
	const state = new CompactSessionState({ dir: root.dir, spillAboveBytes: 0, spillTargetBytes: 0 });
	try {
		for (let i = 0; i < 256; i++)
			state.accept({
				type: "block_start",
				epoch: "A",
				ordinal: i,
				firstOrdinal: 0,
				messageId: "m",
				contentIndex: i,
				kind: "text",
				seed: `text-${i}`,
				coveredCodeUnits: 0,
			});
		const adjust = vi.spyOn(CompactContentStore.prototype, "adjust");
		const cut = state.freeze();
		const freezeVisits = adjust.mock.calls.length;
		const allocate = vi.spyOn(CompactContentStore.prototype, "createLeaf");
		state.accept({ type: "block_delta", messageId: "m", contentIndex: 128, offset: 8, text: "!" });
		const updateLeaves = allocate.mock.calls.length;
		allocate.mockRestore();
		adjust.mockClear();
		state.accept({ type: "message_status", messageId: "m", persistence: "pending" });
		const settleVisits = adjust.mock.calls.length;
		adjust.mockRestore();
		try {
			expect(freezeVisits).toBeLessThanOrEqual(32);
			expect(updateLeaves).toBeLessThanOrEqual(128);
			expect(settleVisits).toBeLessThanOrEqual(256);
			await state.idle();
			expect((await state.read(cut)).messages[0].blocks).toEqual(
				Array.from({ length: 256 }, (_, contentIndex) => ({
					contentIndex,
					kind: "text",
					text: `text-${contentIndex}`,
				})),
			);
			const settled = state.freeze();
			await state.applyCold({ type: "message_remove", messageId: "m" });
			const blocks = (await state.read(settled)).messages[0].blocks;
			expect(blocks).toHaveLength(256);
			expect(blocks[128].text).toBe("text-128!");
			state.release(settled);
		} finally {
			state.release(cut);
		}
		await state.idle();
		expect(state.storageStatus()).toMatchObject({
			structuredBytes: { resident: 0, spilled: 0, pinned: 0 },
			residentPayloadBytes: 0,
			reclaimDebtBytes: 0,
		});
	} finally {
		vi.restoreAllMocks();
		await state.retire();
		await root.cleanup();
	}
}, 120_000);

it("preserves active insertion order and only the addressed block across frozen cuts", async () => {
	const root = await spoolRoot();
	const state = new CompactSessionState({ dir: root.dir });
	try {
		for (const [ordinal, messageId] of ["z", "a"].entries())
			state.accept({
				type: "block_start",
				epoch: "A",
				ordinal,
				firstOrdinal: ordinal,
				messageId,
				contentIndex: 10,
				kind: "text",
				seed: messageId,
				coveredCodeUnits: 0,
			});
		const cut = state.freeze();
		state.accept({ type: "block_delta", messageId: "a", contentIndex: 10, offset: 1, text: "!" });
		const current = state.freeze();
		try {
			expect((await state.read(cut)).messages.map((m) => [m.messageId, m.blocks[0].text])).toEqual([
				["z", "z"],
				["a", "a"],
			]);
			expect((await state.read(current)).messages.map((m) => [m.messageId, m.blocks[0].text])).toEqual([
				["z", "z"],
				["a", "a!"],
			]);
		} finally {
			state.release(cut);
			state.release(current);
		}
	} finally {
		await state.retire();
		await root.cleanup();
	}
});
