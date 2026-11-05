import { afterEach, expect, it, vi } from "vitest";
import { callsRig } from "./4272-calls-support.ts";

// Part of #4272 (S05/S10b, #4568 review LOW 5): a settled terminal owns its call projection before it creates any
// payload leaf or end marker, so a failure to own the projection leaves the settled store exactly as it was.

afterEach(() => {
	vi.restoreAllMocks();
});

it("#4568 LOW 5 a terminal whose call projection cannot be owned leaves no payload leaf and no end marker behind", async () => {
	// Given: a completed call, and the settled store's value owner failing on its next call
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		rig.record({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} });
		rig.record({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: "r", isError: false });
		await rig.lane.idle();
		const probe = rig.lane.freeze();
		const own = vi.spyOn(rig.lane.settledOf(probe).values, "own").mockImplementationOnce(() => {
			throw new Error("injected own failure");
		});
		rig.lane.release(probe);
		await rig.lane.idle();
		const before = rig.lane.storageStatus();
		// When: its toolResult, two payload leaves long, settles the call
		expect(() => rig.toolResult("c1", "read", "x".repeat(40_000))).toThrow("injected own failure");
		await rig.lane.idle();
		// Then: the owner failed once and nothing the terminal would have held stayed resident
		expect(own).toHaveBeenCalledTimes(1);
		const after = rig.lane.storageStatus();
		expect(after.residentPayloadBytes, "no payload leaf leaked").toBe(before.residentPayloadBytes);
		expect(after.residentSettledKeys, "no end marker was left").toBe(before.residentSettledKeys);
	} finally {
		await rig.close();
	}
});
