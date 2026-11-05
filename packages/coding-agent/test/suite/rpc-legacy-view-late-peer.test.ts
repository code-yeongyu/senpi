import { afterEach, expect, it, vi } from "vitest";
import { CompactLaneCurrent } from "../../src/modes/rpc/compact-lane-current.ts";
import { CompactSettledMessages } from "../../src/modes/rpc/compact-settled-messages.ts";
import { SessionAcceptanceLane } from "../../src/modes/rpc/session-acceptance-lane.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { EVENT_RESYNC_CAPABILITY } from "../../src/modes/rpc/socket-peer-recovery.ts";
import { LaneProducer } from "./regressions/4272-legacy-view-support.ts";

// Part of #4272 (S07a, RULING-51 Q2=A Q3=A): a seal never cancels a queued attach baseline, and nothing of the sealed
// session follows its session_closed; a session attached after a shed gets its own baseline behind the recovery
// barrier, byte for byte the baseline a fresh peer gets for the same state. A lane-owned session's baseline is read
// from its frozen compact view (S07b), so the seal keeps that root readable until the queued view is delivered.

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

type Peer = { readonly lines: string[]; release(): void };

/** A registered peer whose transport blocks on every write until `release`; `options` are the actor's budget knobs. */
function heldPeer(
	writer: SessionEventWriter,
	id: string,
	options: { readonly maxQueueBytes?: number; readonly stallMs?: number } = {},
): Peer {
	const lines: string[] = [];
	const transport = Promise.withResolvers<void>();
	let released = false;
	writer.registerConnection(
		id,
		{
			writeRaw: (line) => void lines.push(line),
			waitForBackpressure: () => (released ? Promise.resolve() : transport.promise),
		},
		options,
	);
	return {
		lines,
		release: () => {
			released = true;
			transport.resolve();
		},
	};
}

const delta = (text: string) => ({
	type: "message_update",
	assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
	message: null,
});
const shape = (lines: readonly string[]) =>
	lines.map((line) => {
		const record = JSON.parse(line) as {
			type: string;
			sessionId?: string;
			reason?: string;
			assistantMessageEvent?: { delta: string };
		};
		const name = record.type === "resync_required" ? `resync_required:${record.reason}` : record.type;
		return `${record.sessionId ?? "-"}:${record.assistantMessageEvent?.delta ?? name}`;
	});

it.each([
	{ flag: "0", lane: false },
	{ flag: "0", lane: true },
	{ flag: "1", lane: false },
	{ flag: "1", lane: true },
])(
	"Q2=A seal (flag $flag, lane $lane): the queued baseline, then session_closed, and nothing of the session after it",
	async ({ flag, lane: withLane }) => {
		vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", flag);
		const writer = new SessionEventWriter(() => {});
		const lane = new SessionAcceptanceLane();
		lane.bootstrap({ transcript: [] });
		if (withLane) writer.registerAcceptance("s", lane);
		const closer = heldPeer(writer, "closer");
		closer.release();
		const peer = heldPeer(writer, "peer");
		writer.attachConnectionToSession("peer", "other");
		// Given: the transport is held on an earlier record, so the attach baseline of `s` is still queued at the seal.
		// A lane-owned session's records reach its lane first, as the binding feeds them; its frozen view rebuilds the
		// open text block as its start plus the prefix. Without a lane the writer retains today's records.
		writer.enqueue("other", { type: "message_start", message: { role: "assistant", content: [] } });
		const producer = new LaneProducer(writer, lane, "s");
		const message = { role: "assistant", content: [] };
		if (withLane) {
			producer.assistant({ type: "message_start", message }, { type: "message_start", message });
			producer.blockStart("text", 0);
			producer.blockDelta("text", 0, "one", 0);
		} else {
			writer.enqueue("s", { type: "message_start", message });
			writer.enqueue("s", delta("one"));
		}
		writer.attachConnectionToSession("peer", "s");
		if (withLane) producer.blockDelta("text", 0, "two", 3);
		else writer.enqueue("s", delta("two"));
		expect(writer.openLegacyViews, "the queued baseline").toBe(1);
		expect(lane.liveRoots, "the attach pinned the root only when a lane is registered").toBe(withLane ? 1 : 0);
		// When: another client closes the session before a byte of the baseline is written; then the session keeps producing.
		writer.withConnection("closer", () =>
			writer.closeSession("s", { type: "response", command: "close_session", success: true }, "client_close"),
		);
		expect(lane.retired, "the seal retired the lane").toBe(withLane);
		expect(lane.liveRoots, "the queued view keeps its root past the seal").toBe(withLane ? 1 : 0);
		expect(writer.enqueue("s", delta("late")), "a late record of the sealed session").toBe(false);
		writer.publishLoadedSurfacesChanged("s", undefined, "digest");
		writer.enqueue("other", delta("sibling"));
		peer.release();
		await writer.flush();
		// Then: the frozen baseline is delivered, then session_closed, and no later record of `s`; the sibling continues.
		expect(shape(peer.lines)).toEqual([
			"other:message_start",
			"s:message_start",
			...(withLane ? ["s:message_update"] : []),
			"s:one",
			"s:two",
			"s:session_closed",
			"other:sibling",
		]);
		const closed = peer.lines.findIndex((line) => line.includes('"type":"session_closed"'));
		expect(peer.lines[closed]).toBe('{"type":"session_closed","sessionId":"s","reason":"client_close"}\n');
		expect(shape(peer.lines.slice(closed + 1)).filter((entry) => entry.startsWith("s:"))).toEqual([]);
		expect(shape(closer.lines).filter((entry) => entry.startsWith("s:"))).toEqual(["s:session_closed", "s:response"]);
		expect(lane.liveRoots, "live roots after the seal and the delivery").toBe(0);
		expect(writer.openLegacyViews, "open views after the delivery").toBe(0);
		writer.unregisterConnection("peer");
		writer.unregisterConnection("closer");
		lane.retire("close");
		await lane.idle();
	},
);

it.each(["peer drop", "detach"] as const)(
	"Q2=A seal, then a %s: the kept root of the queued baseline is released by the cancellation and the lane's storage retires",
	async (cause) => {
		vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
		const writer = new SessionEventWriter(() => {});
		const lane = new SessionAcceptanceLane();
		lane.bootstrap({ transcript: [] });
		writer.registerAcceptance("s", lane);
		const storage = [
			vi.spyOn(CompactLaneCurrent.prototype, "retire"),
			vi.spyOn(CompactSettledMessages.prototype, "retire"),
		];
		const retirements = () => storage.map((spy) => spy.mock.calls.length);
		const closer = heldPeer(writer, "closer");
		closer.release();
		const peer = heldPeer(writer, "peer");
		writer.attachConnectionToSession("peer", "other");
		// Given: the transport is held on an earlier record, so the attach baseline of `s` is still queued at the seal.
		writer.enqueue("other", { type: "message_start", message: { role: "assistant", content: [] } });
		const producer = new LaneProducer(writer, lane, "s");
		const message = { role: "assistant", content: [] };
		producer.assistant({ type: "message_start", message }, { type: "message_start", message });
		producer.blockStart("text", 0);
		producer.blockDelta("text", 0, "one", 0);
		writer.attachConnectionToSession("peer", "s");
		writer.withConnection("closer", () =>
			writer.closeSession("s", { type: "response", command: "close_session", success: true }, "client_close"),
		);
		expect(lane.retired, "the seal retired the lane").toBe(true);
		expect(lane.liveRoots, "the queued view keeps its root past the seal").toBe(1);
		expect(retirements(), "storage is kept while that root is held").toEqual([0, 0]);
		// When: the view is cancelled before a byte of it is written: the peer goes away, or it detaches the session.
		if (cause === "peer drop") writer.unregisterConnection("peer");
		else writer.detachConnectionFromSession("peer", "s");
		const atCancel = shape(peer.lines);
		writer.enqueue("other", delta("sibling"));
		peer.release();
		await writer.flush();
		// Then: no frame of the baseline is written; a dropped peer gets nothing more at all.
		expect(atCancel).toEqual(["other:message_start"]);
		expect(shape(peer.lines)).toEqual(
			cause === "peer drop" ? atCancel : ["other:message_start", "s:session_closed", "other:sibling"],
		);
		// And: the cancellation released the kept root, and that last release retired the lane's storage, once.
		expect(lane.liveRoots, "live roots after the cancellation").toBe(0);
		expect(writer.openLegacyViews, "open views after the cancellation").toBe(0);
		expect(retirements(), "current and settled storage retired by the last release").toEqual([1, 1]);
		for (const id of ["peer", "closer"]) writer.unregisterConnection(id);
		await lane.idle();
	},
);

/** The state a late peer attaches to: an active message and a still-open broadcast question with a deadline. */
function seedLateSession(writer: SessionEventWriter): void {
	writer.enqueue("late", { type: "message_start", message: { role: "assistant", content: [] } });
	writer.enqueue("late", delta("a"));
	writer.enqueue("late", {
		type: "extension_ui_request",
		id: "q",
		method: "question",
		questions: [],
		deadlineAtMs: 9_000,
	});
}

it("Q3=A post-shed attach: the session gets its own baseline behind the recovery barrier, its bytes equal a fresh attach", async () => {
	vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1");
	vi.useFakeTimers({ now: 1_000 });
	const writer = new SessionEventWriter(() => {});
	const peer = heldPeer(writer, "peer", { maxQueueBytes: 360, stallMs: 50 });
	writer.setConnectionCapabilities("peer", [EVENT_RESYNC_CAPABILITY]);
	writer.attachConnectionToSession("peer", "s");
	seedLateSession(writer);
	// Given: the message start of `s` is in flight on the held transport; the updates overflow the budget and shed.
	writer.enqueue("s", { type: "message_start", message: { role: "assistant", content: "" } });
	for (let index = 1; index <= 3; index++)
		writer.enqueue("s", {
			type: "message_update",
			message: { role: "assistant", content: `${index}${"x".repeat(60)}` },
		});
	// When: the peer attaches `late` while the recovery is pending, and a fresh, healthy peer attaches it at the same clock.
	writer.attachConnectionToSession("peer", "late");
	const fresh = heldPeer(writer, "fresh");
	fresh.release();
	writer.attachConnectionToSession("fresh", "late");
	writer.enqueue("late", delta("b"));
	peer.release();
	await writer.flush();
	// Then: the late session's lines follow the recovery barrier (gap, the cut at C) and carry no resync entry of their own.
	const lines = shape(peer.lines);
	expect(lines.slice(0, 4)).toEqual([
		"-:rpc_ping",
		"s:message_start",
		"-:resync_required:overflow",
		"s:resync_required:overflow",
	]);
	const late = peer.lines.filter((line) => line.includes('"sessionId":"late"'));
	expect(lines.slice(4)).toEqual(shape(late));
	expect(shape(late)).toEqual(["late:message_start", "late:a", "late:extension_ui_request", "late:b"]);
	// And: byte for byte the frames a fresh attach of the same state wrote, the question's remainingMs at the attach clock.
	expect(late).toEqual(fresh.lines);
	expect(late[2]).toContain('"remainingMs":8000');
	expect(writer.openLegacyViews).toBe(0);
	writer.unregisterConnection("peer");
	writer.unregisterConnection("fresh");
});
