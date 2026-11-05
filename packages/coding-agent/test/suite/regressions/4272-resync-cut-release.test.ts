import { expect, it } from "vitest";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { shedThenEnd } from "./4272-resync-shed-support.ts";

// Part of #4272, ruling 10 Q1 (S07b): freezing the root at the shed changes nothing the peer receives, apart from
// the message slot, which a lane-owned session reads from its frozen compact view (RULING-25 Q2) and a session
// without a lane from today's retention; neither session here has an active message, so the frames are equal.
it("Q1 keeps the resync bytes, reasons and order the peer received without a lane", async () => {
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: [] });
	const withLane = await shedThenEnd("takeSnapshot", lane);
	const without = await shedThenEnd("takeSnapshot");
	expect(withLane.writes.some((line) => line.includes('"type":"resync_required"'))).toBe(true);
	expect(withLane.writes).toEqual(without.writes);
});
