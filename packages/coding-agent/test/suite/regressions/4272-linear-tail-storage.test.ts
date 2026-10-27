import { expect, it, vi } from "vitest";
import { COMPACT_LEAF_CODE_UNITS as LEAF, CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { CompactSessionState } from "../../../src/modes/rpc/compact-session-state.ts";
import { spoolRoot, startBlock } from "../compact-storage-support.ts";

// #4272: count every allocated structural byte, not just surviving/spilled pages.
it("stores single-unit deltas with linear byte volume through the seal bound", async () => {
	const root = await spoolRoot();
	const state = new CompactSessionState({ dir: root.dir });
	const create = CompactContentStore.prototype.createLeaf;
	let structuralBytes = 0;
	const allocate = vi.spyOn(CompactContentStore.prototype, "createLeaf").mockImplementation(function (
		this: CompactContentStore,
		text,
		value,
	) {
		if (value) structuralBytes += text.length * 2;
		allocate.mockClear(); // Measurement must not retain all historical text arguments.
		return create.call(this, text, value);
	});
	const cuts: Array<ReturnType<CompactSessionState["freeze"]>> = [];
	try {
		state.accept(startBlock("m", ""));
		for (let offset = 0; offset < LEAF; offset++) {
			state.accept({ type: "block_delta", messageId: "m", contentIndex: 0, offset, text: "x" });
			if ([LEAF / 8, LEAF / 4, LEAF / 2, LEAF].includes(offset + 1)) {
				cuts.push(state.freeze());
				console.error(`TAIL_BYTES units=${offset + 1} structural=${structuralBytes}`);
			}
		}
		// At most 4 KiB of structural descriptors per one-unit delta (plus the start).
		expect(structuralBytes).toBeLessThanOrEqual(4096 * (LEAF + 1));
		for (const [index, cut] of cuts.entries())
			expect((await state.read(cut)).messages[0].blocks[0].text).toBe("x".repeat(LEAF / 2 ** (3 - index)));
		state.accept({ type: "message_status", messageId: "m", persistence: "pending" });
		await state.applyCold({ type: "message_remove", messageId: "m" });
	} finally {
		allocate.mockRestore();
		for (const cut of cuts) state.release(cut);
		await state.retire();
		await root.cleanup();
	}
}, 120_000);
