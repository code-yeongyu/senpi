import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { CallProjection } from "../../../src/modes/rpc/compact-call-model.ts";
import { checkpointComponents } from "../../../src/modes/rpc/compact-catalog-families.ts";
import { CompactValues } from "../../../src/modes/rpc/compact-values.ts";
import { type CallsRig, callsRig } from "./4272-calls-support.ts";

// Part of #4272 (S10b, RULING-60 Q3, RULING-49): a settled call projection is paged, never truncated: at most 128 child
// descriptors and 64 KiB per value page, recursively, walked iteratively with one page resident whatever the depth or
// the child count; `omitted` is 0 on every path because no path truncates any more.

const start = (toolCallId: string, parentToolCallId?: string) => ({
	type: "tool_execution_start",
	toolCallId,
	toolName: "read",
	args: { id: toolCallId },
	...(parentToolCallId === undefined ? {} : { parentToolCallId }),
});
const end = (toolCallId: string) => ({
	type: "tool_execution_end",
	toolCallId,
	toolName: "read",
	result: "r",
	isError: false,
});
const sha256 = (text: string) => createHash("sha256").update(Buffer.from(text, "utf16le")).digest("hex");

/** The one settled member of the cut as the producer streams it: its digest, length and the settled value reader's peak. */
async function settledMember(rig: CallsRig) {
	const root = rig.lane.freeze();
	try {
		const settled = rig.lane.settledOf(root);
		return await rig.lane.cutStorage(root, async (store, valid) => {
			const values = new CompactValues(store);
			let digest = "";
			let length = 0;
			let members = 0;
			for await (const part of checkpointComponents({ store, values, root, settled }, valid)) {
				if (part.kind !== "settled") continue;
				members += 1;
				const hash = createHash("sha256");
				for (const leaf of part.leaves) {
					const text = await store.readLeaf(leaf);
					length += text.length;
					hash.update(Buffer.from(text, "utf16le"));
				}
				digest = hash.digest("hex");
			}
			return { digest, length, members, peak: settled.values.peakResidentPages };
		});
	} finally {
		rig.lane.release(root);
	}
}

it("RULING-60 Q3 10,000 completed children at one level are all members of the parent's projection, paged with one value page resident, omitted 0", async () => {
	// Given: a parent call with 10,000 completed children, settled by its toolResult
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		rig.record(start("p"));
		for (let index = 0; index < 10_000; index++) {
			rig.record(start(`p/${index}`, "p"));
			rig.record(end(`p/${index}`));
		}
		rig.record(end("p"));
		rig.toolResult("p", "read", "done");
		await rig.lane.idle();
		// When: the whole-view reader and the catalog producer both read the settled row
		const root = rig.lane.freeze();
		const row = (await rig.lane.readSettled(root)).settledMessages[0];
		rig.lane.release(root);
		const member = await settledMember(rig);
		// Then: nothing was truncated, and the streamed member is the canonical JSON of the whole-view row
		expect(row?.call?.nestedCalls).toMatchObject({ complete: true, omitted: 0 });
		expect(row?.call?.nestedCalls.calls).toHaveLength(10_000);
		const expected = JSON.stringify({
			messageId: row?.messageId,
			turnId: row?.turnId,
			terminalSequence: row?.terminalSequence,
			role: row?.role,
			runtimeItemKey: row?.runtimeItemKey,
			entryId: row?.entryId,
			status: row?.status,
			error: row?.error,
			payload: { terminal: row?.terminal, correlation: row?.correlation },
			call: row?.call,
		});
		expect(member.members).toBe(1);
		expect(member.length).toBe(expected.length);
		expect(member.digest).toBe(sha256(expected));
		expect(member.peak, "one value page resident while the projection streams").toBe(1);
	} finally {
		await rig.close();
	}
}, 120_000);

it("RULING-60 Q3 a projection nested 1,000 levels deep streams iteratively with one page resident and is complete at every level", async () => {
	// Given: a chain of 1,000 nested calls, each the parent of the next, all completed and settled by the root's toolResult
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		rig.record(start("d0"));
		for (let depth = 1; depth < 1_000; depth++) rig.record(start(`d${depth}`, `d${depth - 1}`));
		for (let depth = 999; depth >= 0; depth--) rig.record(end(`d${depth}`));
		rig.toolResult("d0", "read", "done");
		await rig.lane.idle();
		// When: the whole-view reader walks the projection and the catalog producer streams it
		const root = rig.lane.freeze();
		const row = (await rig.lane.readSettled(root)).settledMessages[0];
		rig.lane.release(root);
		const member = await settledMember(rig);
		// Then: every level is present and complete with nothing omitted, and the stream kept one page resident
		let depth = 0;
		let call: CallProjection | undefined = row?.call;
		while (call) {
			expect(call.nestedCalls).toMatchObject({ complete: true, omitted: 0 });
			expect(call.nestedCalls.calls.length).toBe(depth === 999 ? 0 : 1);
			call = call.nestedCalls.calls[0];
			depth += 1;
		}
		expect(depth).toBe(1_000);
		expect(member.members).toBe(1);
		expect(member.length).toBeGreaterThan(0);
		expect(member.peak).toBe(1);
	} finally {
		await rig.close();
	}
}, 120_000);
