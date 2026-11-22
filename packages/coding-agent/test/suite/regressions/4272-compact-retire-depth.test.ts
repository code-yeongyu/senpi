import { expect, it } from "vitest";
import type { CompactValues, ValueRef } from "../../../src/modes/rpc/compact-values.ts";
import { callsRig } from "./4272-calls-support.ts";

// Part of #4272 (S06/S10b, RULING-59 (1), RULING-67 (2), #4568 review LOW 4): retiring a settled call walks its
// completed descendants with an explicit stack, so a chain deeper than the JS stack settles, every retired call leaves
// the table, its projection carries every level, and the epoch's compact state stays available.

const DEPTH = 100_000;
const start = (toolCallId: string, parentToolCallId?: string) => ({
	type: "tool_execution_start",
	toolCallId,
	toolName: "read",
	args: {},
	...(parentToolCallId === undefined ? {} : { parentToolCallId }),
});
const end = (toolCallId: string) => ({
	type: "tool_execution_end",
	toolCallId,
	toolName: "read",
	result: "r",
	isError: false,
});

/** One field of a stored object, read from its own pages only (the rest of the value is never walked). */
async function fieldOf(values: CompactValues, ref: ValueRef, name: string): Promise<ValueRef> {
	for await (const [key, value] of values.fields(ref, new Set([name]))) if (key === name) return value;
	return expect.unreachable(`no ${name} field`);
}

it("RULING-67 (2) a call chain 100,000 levels deep retires without throwing, frees every call and leaves the compact state available", async () => {
	// Given: a chain of 100,000 nested calls, each the parent of the next, all completed
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		rig.record(start("d0"));
		for (let depth = 1; depth < DEPTH; depth++) rig.record(start(`d${depth}`, `d${depth - 1}`));
		for (let depth = DEPTH - 1; depth >= 0; depth--) rig.record(end(`d${depth}`));
		// When: the root's toolResult settles the whole chain
		rig.toolResult("d0", "read", "done");
		const root = rig.lane.freeze();
		// Then: the compact state is still available and the call table holds nothing
		expect(root.current, "the compact state is still available").toBeDefined();
		const { calls, counters } = await rig.lane.readCurrentCalls(root);
		expect(calls).toEqual([]);
		expect(counters).toMatchObject({ live: 0, headerBytes: 0, slotBytes: 0 });
		expect(rig.lane.storageStatus().refusedRecords).toBe(0);
		// And: the one settled terminal carries the projection, complete at its root: a call leaves the table only once its
		// projection is in its parent's, so `live: 0` above plus a complete root means every level is projected (the
		// depth-1,000 paging test walks every level; walking 100,000 here would only re-read spilled pages)
		const settled = rig.lane.settledOf(root);
		const projections: ValueRef[] = [];
		for await (const member of settled.members(() => undefined))
			if (member.kind === "terminal" && member.row.call) projections.push(member.row.call);
		expect(projections).toHaveLength(1);
		const nested = await fieldOf(settled.values, projections[0] ?? expect.unreachable(), "nestedCalls");
		expect(await settled.values.read(await fieldOf(settled.values, nested, "complete"))).toBe(true);
		expect(await settled.values.read(await fieldOf(settled.values, nested, "omitted"))).toBe(0);
		rig.lane.release(root);
	} finally {
		await rig.close();
	}
}, 600_000);
