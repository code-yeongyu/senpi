import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { serializeJsonLine } from "../../src/modes/rpc/jsonl.ts";
import { SessionAcceptanceLane } from "../../src/modes/rpc/session-acceptance-lane.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { EVENT_RESYNC_CAPABILITY } from "../../src/modes/rpc/socket-peer-recovery.ts";
import { LaneProducer, update } from "./regressions/4272-legacy-view-support.ts";

// Part of #4272 (S07a, R3.C6.4 T6-L5): with the compact-updates flag on, a shed freezes the cut C at the shed,
// keeps the pre-cut replies, and captures every post-C record behind the recovery baseline instead of dropping
// it; a suffix that overflows releases the cut and reads one fresh cut at the delivery. The cut's message is read
// from the lane's frozen compact view (S07b). With the flag off the shed path is today's
// (issue-3728-live-peer-resync.test.ts).

beforeEach(() => vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1"));
afterEach(() => vi.unstubAllEnvs());

const message = { role: "assistant", content: [] };
const deltaText = (index: number) => `${"x".repeat(60)}${String(index).padStart(2, "0")}`;
const deltaBytes = Buffer.byteLength(
	serializeJsonLine({ ...update({ type: "text_delta", contentIndex: 0, delta: deltaText(0) }), sessionId: "s" }),
);
/** Two deltas fit behind an in-flight record; the third overflows. */
const BUDGET = 2 * deltaBytes + 10;
const shape = (lines: readonly string[]) =>
	lines.map((line) => {
		const record = JSON.parse(line) as {
			type: string;
			id?: string;
			assistantMessageEvent?: { delta?: string };
			message?: { content?: { text: string }[] } | null;
			reason?: string;
		};
		if (record.type === "message_update")
			return `update:${record.assistantMessageEvent?.delta?.slice(-2) ?? "start"}`;
		if (record.type === "resync_required")
			return `resync:${record.reason}:${record.message?.content?.[0]?.text.slice(-2) ?? "gap"}`;
		return record.id === undefined ? record.type : `${record.type}:${record.id}`;
	});

function resyncPeer(writer: SessionEventWriter, id: string) {
	const lines: string[] = [];
	const transport = Promise.withResolvers<void>();
	let held = false;
	const closed = vi.fn();
	writer.registerConnection(
		id,
		{
			writeRaw: (line) => void lines.push(line),
			waitForBackpressure: () => (held ? transport.promise : Promise.resolve()),
			close: closed,
		},
		{ maxQueueBytes: BUDGET },
	);
	writer.setConnectionCapabilities(id, [EVENT_RESYNC_CAPABILITY]);
	return {
		lines,
		closed,
		hold: () => {
			held = true;
		},
		release: () => {
			held = false;
			transport.resolve();
		},
	};
}

/** A lane-owned session attached to one resync peer, with an open text block delivered before the transport is held. */
async function streamingSession() {
	const writer = new SessionEventWriter(() => {});
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: [] });
	writer.registerAcceptance("s", lane);
	const peer = resyncPeer(writer, "peer");
	writer.attachConnectionToSession("peer", "s");
	await writer.flush();
	const producer = new LaneProducer(writer, lane, "s");
	producer.assistant({ type: "message_start", message }, { type: "message_start", message });
	producer.blockStart("text", 0);
	await writer.flush();
	peer.hold();
	let offset = 0;
	const delta = (index: number) => {
		producer.blockDelta("text", 0, deltaText(index), offset);
		offset += deltaText(index).length;
	};
	return { writer, lane, peer, delta };
}

it("T6-L5 shed: pre-cut replies, then the gap and the resync frozen at C, then the post-C suffix in order", async () => {
	const { writer, lane, peer, delta } = await streamingSession();
	// Given: the reply is in flight on the held transport; two deltas fit the budget; delta 3 overflows it.
	writer.withConnection("peer", () => writer.enqueue("s", { type: "response", id: "pre" }));
	for (let index = 1; index <= 3; index++) delta(index);
	expect(lane.liveRoots, "the shed froze the cut").toBe(1);
	// When: the session keeps producing while the recovery is pending.
	delta(4);
	writer.withConnection("peer", () => writer.enqueue("s", { type: "response", id: "post" }));
	peer.release();
	await writer.flush();
	expect(shape(peer.lines)).toEqual([
		"rpc_ping",
		"message_start",
		"update:start",
		"response:pre",
		"resync:overflow:gap",
		"resync:overflow:03",
		"update:04",
		"response:post",
	]);
	expect(lane.liveRoots, "live roots after the recovery").toBe(0);
	expect(writer.openLegacyViews).toBe(0);
	expect(peer.closed).not.toHaveBeenCalled();
	writer.unregisterConnection("peer");
	lane.retire("close");
	await lane.idle();
});

it("T6-L5 supersede: a suffix that overflows releases the pending cut; one fresh cut is read at the delivery", async () => {
	const { writer, lane, peer, delta } = await streamingSession();
	const freeze = vi.spyOn(lane, "freeze");
	const release = vi.spyOn(lane, "release");
	// Given: delta 1 is in flight on the held transport, 2 and 3 fit, 4 overflows and sheds at C.
	for (let index = 1; index <= 4; index++) delta(index);
	expect(freeze, "the shed froze C").toHaveBeenCalledTimes(1);
	// When: the captured suffix (5, 6) overflows at 7; 7 and 8 are dropped like today's path, not cut one by one.
	for (let index = 5; index <= 8; index++) delta(index);
	expect(freeze, "no cut per overflowing record").toHaveBeenCalledTimes(1);
	expect(release, "the cut at C was released at the overflow").toHaveBeenCalledTimes(1);
	expect(lane.liveRoots).toBe(0);
	peer.release();
	await writer.flush();
	// Then: the one fresh cut read at the delivery covers everything dropped since C.
	expect(freeze, "one cut at the delivery").toHaveBeenCalledTimes(2);
	expect(shape(peer.lines)).toEqual([
		"rpc_ping",
		"message_start",
		"update:start",
		"update:01",
		"resync:overflow:gap",
		"resync:overflow:08",
	]);
	expect(release).toHaveBeenCalledTimes(2);
	expect(lane.liveRoots).toBe(0);
	expect(writer.openLegacyViews).toBe(0);
	writer.unregisterConnection("peer");
	lane.retire("close");
	await lane.idle();
});

it("T6-L5 plain peer: a peer without event_resync still closes on overflow while a healthy sibling is unaffected", async () => {
	const writer = new SessionEventWriter(() => {});
	const plainLines: string[] = [];
	const plainClosed = vi.fn();
	const healthyLines: string[] = [];
	writer.registerConnection(
		"plain",
		{
			writeRaw: (line) => void plainLines.push(line),
			waitForBackpressure: () => new Promise<void>(() => {}),
			close: plainClosed,
		},
		{ maxQueueBytes: BUDGET },
	);
	writer.registerConnection("healthy", {
		writeRaw: (line) => void healthyLines.push(line),
		waitForBackpressure: async () => {},
	});
	writer.attachConnectionToSession("plain", "s");
	writer.attachConnectionToSession("healthy", "s");
	for (let index = 0; index <= 4; index++)
		writer.enqueue("s", update({ type: "text_delta", contentIndex: 0, delta: deltaText(index) }));
	await writer.flush();
	expect(plainClosed).toHaveBeenCalledTimes(1);
	expect(plainLines.at(-1)).toBe('{"type":"overflow","error":"overflow, resync required"}\n');
	expect(shape(healthyLines)).toEqual(["update:00", "update:01", "update:02", "update:03", "update:04"]);
	writer.unregisterConnection("healthy");
});
