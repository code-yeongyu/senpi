import { afterEach, expect, it, vi } from "vitest";
import { serializeJsonLine } from "../../../src/modes/rpc/jsonl.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { EVENT_RESYNC_CAPABILITY } from "../../../src/modes/rpc/socket-peer-recovery.ts";
import { heldPeer as peer, LaneProducer, update, usage } from "./4272-legacy-view-support.ts";

// Part of #4272 (S08a, RULING-46 item 1): the fanout's attach and shed are the real producers of the admission
// descriptor before S15; each freezes its cut synchronously as that admission's checkpoint and releases it on end.

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const start = { role: "assistant", content: [], api: "faux", provider: "faux", model: "fixture", usage };

it("T5 the attach is the real producer: it mints the admission and freezes C in one synchronous step, the baseline is C while more content is accepted, and the token is released when the barrier ends", async () => {
	vi.useFakeTimers({ now: 1_000 });
	const writer = new SessionEventWriter(() => {});
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: [] });
	writer.registerAcceptance("s", lane);
	const producer = new LaneProducer(writer, lane, "s");
	producer.assistant({ type: "message_start", message: start }, { type: "message_start", message: start });
	producer.blockStart("text", 0);
	producer.blockDelta("text", 0, "hel", 0);
	const late = peer(writer, "late");
	late.hold();
	writer.attachConnectionToSession("late", "s");
	const [token] = writer.recoveryCheckpoints.tokens();
	expect(writer.recoveryCheckpoints.tokens(), "the attach froze exactly one cut").toHaveLength(1);
	expect(token).toMatchObject({
		kind: "checkpoint",
		admission: {
			routeKind: "ordinary",
			peer: "late",
			sessionId: "s",
			sessionEpoch: lane.sessionEpoch,
			generation: 1,
		},
		cut: { sessionEpoch: lane.sessionEpoch, activeMessageId: "message-1" },
	});
	expect(token?.admission.admissionId.length).toBeGreaterThan(0);
	expect(token?.admission.socketEpoch.length).toBeGreaterThan(0);
	// A repeated hold adds no cut; content accepted behind the barrier is the suffix, not the baseline.
	writer.attachConnectionToSession("late", "s");
	expect(writer.recoveryCheckpoints.tokens()).toHaveLength(1);
	producer.blockDelta("text", 0, "lo", 3);
	late.release();
	await writer.flush();
	const reference = [
		{ type: "message_start", message: { ...start, content: [{ type: "text", text: "" }] } },
		update({ type: "text_start", contentIndex: 0 }),
		update({ type: "text_delta", contentIndex: 0, delta: "hel" }),
		update({ type: "text_delta", contentIndex: 0, delta: "lo" }),
	].map((record) => serializeJsonLine({ ...record, sessionId: "s" }));
	expect(late.lines).toEqual(reference);
	expect(writer.recoveryCheckpoints.open).toBe(0);
	expect(lane.liveRoots).toBe(0);
	writer.unregisterConnection("late");
	lane.retire("close");
	await lane.idle();
});

it("T5 a shed freezes C synchronously before the drain await as the next generation of the same admission", async () => {
	vi.useFakeTimers();
	const writer = new SessionEventWriter(() => {});
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: [] });
	writer.registerAcceptance("s", lane);
	const producer = new LaneProducer(writer, lane, "s");
	producer.assistant({ type: "message_start", message: start }, { type: "message_start", message: start });
	producer.blockStart("text", 0);
	const held = peer(writer, "held", [EVENT_RESYNC_CAPABILITY]);
	held.hold();
	writer.attachConnectionToSession("held", "s");
	const [attach] = writer.recoveryCheckpoints.tokens();
	expect(attach?.admission).toMatchObject({ peer: "held", sessionId: "s", generation: 1 });
	held.release();
	await writer.flush();
	expect(writer.recoveryCheckpoints.open).toBe(0);
	held.hold();
	for (let index = 0; index < 200 && writer.recoveryCheckpoints.open === 0; index++)
		producer.blockDelta("text", 0, "x", index);
	const [shed] = writer.recoveryCheckpoints.tokens();
	expect(writer.recoveryCheckpoints.tokens(), "the shed froze C before any await").toHaveLength(1);
	expect(shed?.admission).toEqual({ ...attach?.admission, generation: 2 });
	expect(lane.liveRoots).toBe(1);
	held.release();
	await writer.flush();
	expect(held.lines.some((line) => line.includes('"resync_required"'))).toBe(true);
	expect(writer.recoveryCheckpoints.open).toBe(0);
	expect(lane.liveRoots).toBe(0);
	writer.unregisterConnection("held");
	lane.retire("close");
	await lane.idle();
});
