import { expect, it } from "vitest";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { type ShedEnd, shedThenEnd } from "./4272-resync-shed-support.ts";

async function shedOnLane(end: ShedEnd) {
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: [] });
	const result = await shedThenEnd(end, lane);
	expect(result.liveDuringShed, "the shed froze the attached session's root before awaiting the drain").toBe(1);
	return result;
}

// Part of #4272, ruling 10 Q1: the event-resync shed is freeze's real caller; every end releases its root.
it("Q1 takeSnapshot: the delivered resync releases the shed's frozen root, zero live roots", async () => {
	const result = await shedOnLane("takeSnapshot");
	expect(result.writes.some((line) => line.includes('"type":"resync_required"'))).toBe(true);
	expect(result.liveAfter, "live roots after takeSnapshot").toBe(0);
	expect(result.retired, "the session is still live").toBe(false);
});

it("Q1 drain failure: a failing peer transport releases the shed's frozen root, zero live roots", async () => {
	const result = await shedOnLane("drain_failure");
	expect(result.writes.some((line) => line.includes('"type":"resync_required"'))).toBe(false);
	expect(result.liveAfter, "live roots after the drain failed").toBe(0);
});

it("Q1 seal by close_session: the lane retires and releases the shed's frozen root, zero live roots", async () => {
	const result = await shedOnLane("close_session");
	expect(result.retired, "sealing the session retires its lane").toBe(true);
	expect(result.liveAfter, "live roots after close_session").toBe(0);
});

it("Q1 seal by abort: an error seal retires the lane and releases the shed's frozen root, zero live roots", async () => {
	const result = await shedOnLane("abort_seal");
	expect(result.retired, "the error seal retires the lane").toBe(true);
	expect(result.liveAfter, "live roots after the error seal").toBe(0);
});

it("Q1 peer drop: closing the peer's actor releases the shed's frozen root, zero live roots", async () => {
	const result = await shedOnLane("peer_drop");
	expect(result.retired, "dropping one peer leaves the session live").toBe(false);
	expect(result.liveAfter, "live roots after the peer dropped").toBe(0);
});
