import { expect, it } from "vitest";
import { CompactSessionState } from "../../../src/modes/rpc/compact-session-state.ts";
import { spoolRoot, startIdentity } from "../compact-storage-support.ts";

// senpi#4272 / RULING-34: the real settled consumer reads large structured collections through the substrate.
it("retains a large settled block collection across a cold status update", async () => {
	const root = await spoolRoot();
	const state = new CompactSessionState({
		dir: root.dir,
		spillAboveBytes: 0,
		spillTargetBytes: 0,
		compactAboveRows: 1,
	});
	try {
		const identity = startIdentity();
		for (let contentIndex = 0; contentIndex < 1024; contentIndex++)
			state.accept({
				type: "block_start",
				...(contentIndex === 0 ? identity : startIdentity(identity.firstOrdinal)),
				messageId: "old",
				contentIndex,
				kind: "text",
				seed: `body-${contentIndex}`,
				coveredCodeUnits: 0,
			});
		state.accept({ type: "message_status", messageId: "old", persistence: "pending" });
		await state.idle();
		const cut = state.freeze();
		await state.applyCold({ type: "message_status", messageId: "old", persistence: "appended" });
		await state.idle();
		try {
			const view = await state.read(cut);
			expect(view.messages[0].persistence).toBe("pending");
			expect(view.messages[0].blocks).toEqual(
				Array.from({ length: 1024 }, (_, contentIndex) => ({
					contentIndex,
					kind: "text",
					text: `body-${contentIndex}`,
				})),
			);
		} finally {
			state.release(cut);
		}
	} finally {
		await state.retire();
		await root.cleanup();
	}
}, 120_000);
