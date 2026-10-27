import { expect, it } from "vitest";
import { CompactSessionState } from "../../../src/modes/rpc/compact-session-state.ts";
import { spoolRoot, startIdentity } from "../compact-storage-support.ts";

// senpi#4272 / RULING-40: the original binding rejects a fresh ordinal targeting a settled key.
it("rejects duplicate settled starts and unknown operations without changing the accepted root", async () => {
	const root = await spoolRoot();
	const state = new CompactSessionState({
		dir: root.dir,
		spillAboveBytes: 0,
		spillTargetBytes: 0,
		compactAboveRows: 1,
	});
	try {
		const identity = startIdentity();
		state.accept({
			type: "block_start",
			...identity,
			messageId: "old",
			contentIndex: 0,
			kind: "text",
			seed: "body",
			coveredCodeUnits: 0,
		});
		state.accept({ type: "message_status", messageId: "old", persistence: "pending" });
		await state.idle();
		const sequence = state.acceptedSequence;
		const status = state.storageStatus();
		for (const [transition, reason] of [
			[
				{
					type: "block_start",
					...startIdentity(identity.firstOrdinal),
					messageId: "old",
					contentIndex: 1,
					kind: "text",
					seed: "",
					coveredCodeUnits: 0,
				},
				"duplicate_or_stale_start",
			],
			[{ type: "message_status", messageId: "missing", persistence: "failed" }, "cold_operation_required"],
			[{ type: "message_remove", messageId: "missing" }, "cold_operation_required"],
		] as const)
			expect(() => state.accept(transition)).toThrow(expect.objectContaining({ reason }));
		expect(state.acceptedSequence).toBe(sequence);
		expect(state.storageStatus()).toEqual(status);
		expect(await state.applyCold({ type: "message_remove", messageId: "missing" })).toMatchObject({
			kind: "rejected",
			reason: "unknown_message",
		});
		await state.applyCold({ type: "message_status", messageId: "old", persistence: "appended" });
		const cut = state.freeze();
		try {
			expect((await state.read(cut)).messages[0]).toEqual({
				messageId: "old",
				persistence: "appended",
				blocks: [{ contentIndex: 0, kind: "text", text: "body" }],
			});
		} finally {
			state.release(cut);
		}
	} finally {
		await state.retire();
		await root.cleanup();
	}
});
