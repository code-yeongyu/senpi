import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { EVENT_RESYNC_CAPABILITY } from "../../../src/modes/rpc/socket-peer-recovery.ts";
import { LaneProducer, usage } from "./4272-legacy-view-support.ts";

// Part of #4272 (S07b, R3.C6.4 design section 4, carry 30): with the compact-updates flag on, a shed's resync
// carries C's current message read from the lane's frozen view, and a session whose attachment changed since the
// shed is reported closed with nothing to resume.

beforeEach(() => vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1"));
afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

const start = { role: "assistant", content: [], api: "faux", provider: "faux", model: "fixture", usage };

type Resync = { type: string; sessionId?: string; reason?: string; message?: unknown; closed?: boolean };

function resyncPeer(maxQueueBytes: number) {
	const writer = new SessionEventWriter(() => {});
	const records: Resync[] = [];
	let blocked = false;
	const drain = Promise.withResolvers<void>();
	writer.registerConnection(
		"peer",
		{
			writeRaw: (line) => void records.push(JSON.parse(line) as Resync),
			waitForBackpressure: () => (blocked ? drain.promise : Promise.resolve()),
		},
		{ maxQueueBytes },
	);
	writer.setConnectionCapabilities("peer", [EVENT_RESYNC_CAPABILITY]);
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: [] });
	writer.registerAcceptance("s", lane);
	return {
		writer,
		lane,
		records,
		hold: () => {
			blocked = true;
		},
		release: async () => {
			blocked = false;
			drain.resolve();
			await writer.flush();
		},
	};
}

/** Streams one-character deltas on a held transport until the actor sheds; returns the text accepted at C. */
function streamUntilShed(peer: ReturnType<typeof resyncPeer>, producer: LaneProducer): string {
	let text = "";
	for (let index = 0; index < 200 && peer.lane.liveRoots === 0; index++) {
		producer.blockDelta("text", 0, "x", index);
		text += "x";
	}
	expect(peer.lane.liveRoots, "the shed froze C").toBe(1);
	return text;
}

it("a shed's resync carries C's current message from the frozen view, then the captured suffix", async () => {
	vi.useFakeTimers();
	const peer = resyncPeer(600);
	peer.writer.attachConnectionToSession("peer", "s");
	await peer.writer.flush();
	const producer = new LaneProducer(peer.writer, peer.lane, "s");
	producer.assistant({ type: "message_start", message: start }, { type: "message_start", message: start });
	producer.blockStart("text", 0);
	await peer.writer.flush();
	peer.hold();
	const atC = streamUntilShed(peer, producer);
	producer.blockDelta("text", 0, "y", atC.length);
	producer.blockDelta("text", 0, "z", atC.length + 1);
	await peer.release();
	const gap = peer.records.findIndex((record) => record.type === "resync_required" && record.sessionId === undefined);
	expect(peer.records[gap + 1]).toEqual({
		type: "resync_required",
		sessionId: "s",
		reason: "overflow",
		message: { ...start, content: [{ type: "text", text: atC }] },
	});
	const suffix = peer.records
		.slice(gap + 2)
		.map((record) => (record as { assistantMessageEvent?: { delta: string } }).assistantMessageEvent?.delta);
	expect(suffix).toEqual(["y", "z"]);
	expect(peer.lane.liveRoots).toBe(0);
	expect(peer.writer.openLegacyViews).toBe(0);
	peer.writer.unregisterConnection("peer");
	peer.lane.retire("close");
	await peer.lane.idle();
});

it("carry 30: a session detached and re-attached between the shed and the read is reported closed; the new attachment gets its own baseline", async () => {
	vi.useFakeTimers();
	const peer = resyncPeer(600);
	peer.writer.attachConnectionToSession("peer", "s");
	await peer.writer.flush();
	const producer = new LaneProducer(peer.writer, peer.lane, "s");
	producer.assistant({ type: "message_start", message: start }, { type: "message_start", message: start });
	producer.blockStart("text", 0);
	await peer.writer.flush();
	peer.hold();
	const atC = streamUntilShed(peer, producer);
	peer.writer.detachConnectionFromSession("peer", "s");
	peer.writer.attachConnectionToSession("peer", "s");
	await peer.release();
	const gap = peer.records.findIndex((record) => record.type === "resync_required" && record.sessionId === undefined);
	expect(peer.records[gap + 1]).toEqual({
		type: "resync_required",
		sessionId: "s",
		reason: "overflow",
		message: null,
		closed: true,
	});
	const baseline = peer.records.slice(gap + 2).map((record) => record.type);
	expect(baseline).toEqual(["message_start", "message_update", "message_update"]);
	expect((peer.records.at(-1) as { assistantMessageEvent?: { delta?: string } }).assistantMessageEvent?.delta).toBe(
		atC,
	);
	expect(peer.lane.liveRoots).toBe(0);
	expect(peer.writer.openLegacyViews).toBe(0);
	peer.writer.unregisterConnection("peer");
	peer.lane.retire("close");
	await peer.lane.idle();
});
