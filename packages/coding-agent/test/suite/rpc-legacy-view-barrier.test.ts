import { expect, it, vi } from "vitest";
import { MEDIA_PLACEHOLDERS_CAPABILITY } from "../../src/modes/rpc/custom-capability.ts";
import { serializeJsonLine } from "../../src/modes/rpc/jsonl.ts";
import { omitNormalInlineMedia } from "../../src/modes/rpc/media-placeholders.ts";
import { SessionAcceptanceLane } from "../../src/modes/rpc/session-acceptance-lane.ts";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { LaneProducer } from "./regressions/4272-legacy-view-support.ts";

// Part of #4272 (S07a, R3.C6.4 T6-L4 / RULING-25 Q1 Q2 Q4): a peer's attach baseline is one barrier in its own
// FIFO, frozen at the attach and written before every record accepted behind it. A lane-owned session's view is
// read from its frozen compact state (S07b); a session without a lane keeps today's retained view (Q5).

type Peer = {
	readonly lines: string[];
	/** Resolves when the sink receives its next write (an exact observation, never a settle). */
	nextWrite(): Promise<void>;
	/** Opens the transport: the held write and every later one resolve at once. */
	release(): void;
};

/** One registered peer whose transport blocks on every write until `release`. */
function heldPeer(writer: SessionEventWriter, id: string, capabilities: readonly string[] = []): Peer {
	const lines: string[] = [];
	let released = false;
	const waiters: (() => void)[] = [];
	let writeWaiter: (() => void) | undefined;
	writer.registerConnection(id, {
		writeRaw: (chunk) => {
			lines.push(chunk);
			writeWaiter?.();
			writeWaiter = undefined;
		},
		waitForBackpressure: () =>
			released ? Promise.resolve() : new Promise<void>((resolve) => void waiters.push(resolve)),
	});
	if (capabilities.length > 0) writer.setConnectionCapabilities(id, capabilities);
	return {
		lines,
		nextWrite: () =>
			new Promise<void>((resolve) => {
				writeWaiter = resolve;
			}),
		release: () => {
			released = true;
			for (const resolve of waiters.splice(0)) resolve();
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
			assistantMessageEvent?: { delta: string };
		};
		return `${record.sessionId ?? "-"}:${record.assistantMessageEvent?.delta ?? record.type}`;
	});

const message = { role: "assistant", content: [] };

/** A lane-owned session with an open assistant text block streamed through its lane, as the binding would. */
function laneFor(writer: SessionEventWriter, sessionId: string, ...deltas: readonly string[]) {
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: [] });
	writer.registerAcceptance(sessionId, lane);
	const producer = new LaneProducer(writer, lane, sessionId);
	producer.assistant({ type: "message_start", message }, { type: "message_start", message });
	producer.blockStart("text", 0);
	let offset = 0;
	for (const text of deltas) {
		producer.blockDelta("text", 0, text, offset);
		offset += text.length;
	}
	return { lane, producer, offset };
}

it("T6-L4 FIFO: the baseline frozen at attach is written before every record accepted behind it, then the suffix", async () => {
	const writer = new SessionEventWriter(() => {});
	const peer = heldPeer(writer, "peer");
	writer.attachConnectionToSession("peer", "other");
	// Given: the transport is held on an earlier record, so nothing of the baseline is written before the suffix is accepted.
	writer.enqueue("other", { type: "agent_start" });
	writer.enqueue("s", { type: "message_start", message: { role: "assistant", content: [] } });
	writer.enqueue("s", delta("one"));
	writer.attachConnectionToSession("peer", "s");
	writer.enqueue("s", delta("two"));
	writer.enqueue("s", { type: "message_end" });
	writer.enqueue("s", { type: "message_start", message: { role: "assistant", content: [] } });
	writer.withConnection("peer", () => writer.enqueue("s", { type: "response", id: "reply" }));
	// Neither the frozen baseline nor the capacity of a held peer holds the session's credit.
	await writer.waitForSessionBackpressure("s");
	peer.release();
	await writer.flush();
	expect(shape(peer.lines)).toEqual([
		"other:agent_start",
		"s:message_start",
		"s:one",
		"s:two",
		"s:message_end",
		"s:message_start",
		"s:response",
	]);
	expect(writer.openLegacyViews, "frozen views after delivery").toBe(0);
	writer.unregisterConnection("peer");
});

it("T6-L4 detach: a detach before the baseline is written cancels it, and the stale attempt writes nothing further", async () => {
	const writer = new SessionEventWriter(() => {});
	const peer = heldPeer(writer, "peer");
	writer.attachConnectionToSession("peer", "other");
	writer.enqueue("other", { type: "agent_start" });
	const { lane, producer, offset } = laneFor(writer, "s", "one");
	writer.attachConnectionToSession("peer", "s");
	expect(lane.liveRoots, "the attach froze the session's root").toBe(1);
	writer.detachConnectionFromSession("peer", "s");
	producer.blockDelta("text", 0, "two", offset);
	peer.release();
	await writer.flush();
	expect(shape(peer.lines)).toEqual(["other:agent_start"]);
	expect(lane.liveRoots, "live roots after the cancelled attempt").toBe(0);
	expect(writer.openLegacyViews).toBe(0);
	writer.unregisterConnection("peer");
});

it("T6-L4 replacement: a new lane epoch before the baseline is written cancels it; the next view comes from the new epoch", async () => {
	const writer = new SessionEventWriter(() => {});
	const peer = heldPeer(writer, "peer");
	writer.attachConnectionToSession("peer", "other");
	writer.enqueue("other", { type: "agent_start" });
	const { lane } = laneFor(writer, "s");
	writer.attachConnectionToSession("peer", "s");
	expect(lane.liveRoots).toBe(1);
	// When: the session is replaced (a new lane epoch) while the attach baseline is still queued.
	lane.bootstrap({ transcript: [] });
	writer.enqueue("s", delta("after"));
	peer.release();
	await writer.flush();
	expect(shape(peer.lines)).toEqual(["other:agent_start", "s:after"]);
	expect(lane.liveRoots).toBe(0);
	expect(writer.openLegacyViews).toBe(0);
	writer.unregisterConnection("peer");
});

it("T6-L4 peer drop mid-baseline: the attempt ends in finally, root and cursor counts reach zero", async () => {
	const writer = new SessionEventWriter(() => {});
	const peer = heldPeer(writer, "peer");
	const { lane } = laneFor(writer, "s", "one", "two");
	const firstFrame = peer.nextWrite();
	writer.attachConnectionToSession("peer", "s");
	await firstFrame;
	expect(shape(peer.lines)).toEqual(["s:message_start"]);
	expect(lane.liveRoots).toBe(1);
	expect(writer.openLegacyViews).toBe(1);
	writer.unregisterConnection("peer");
	expect(lane.liveRoots, "live roots after the peer dropped").toBe(0);
	expect(writer.openLegacyViews, "open views after the peer dropped").toBe(0);
	peer.release();
	await writer.flush();
	expect(shape(peer.lines)).toEqual(["s:message_start"]);
});

it("T6-L4 repeated attach: a second hold on the same attached pair adds no baseline", async () => {
	const writer = new SessionEventWriter(() => {});
	const peer = heldPeer(writer, "peer");
	writer.enqueue("s", { type: "message_start", message: { role: "assistant", content: [] } });
	writer.attachConnectionToSession("peer", "s");
	writer.attachConnectionToSession("peer", "s");
	peer.release();
	await writer.flush();
	expect(shape(peer.lines)).toEqual(["s:message_start"]);
	expect(writer.openLegacyViews).toBe(0);
	writer.unregisterConnection("peer");
});

it("Q1 Q2 bytes: late plain and placeholder peers get exactly today's floor, each frame equal to the predecessor serializer's reference", async () => {
	vi.useFakeTimers({ now: 1_000 });
	try {
		const writer = new SessionEventWriter(() => {});
		writer.registerConnection("live", { writeRaw: () => {}, waitForBackpressure: async () => {} });
		writer.attachConnectionToSession("live", "s");
		const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
		const accepted: Record<string, unknown>[] = [
			{ type: "session_lifecycle", state: "running" },
			{ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "" }] } },
			{ ...delta("hi"), message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
			{
				type: "tool_execution_end",
				toolCallId: "call",
				result: { role: "toolResult", toolCallId: "call", content: [image] },
			},
			{ type: "extension_ui_request", id: "q1", method: "question", questions: [], deadlineAtMs: 6_000 },
		];
		// Records outside today's floor: an earlier message that ended, and a resolved question.
		writer.enqueue("s", { type: "message_start", message: { role: "assistant", content: [] } });
		writer.enqueue("s", { type: "message_end" });
		writer.enqueue("s", { type: "extension_ui_request", id: "q0", method: "question", questions: [] });
		writer.enqueue("s", { type: "question_resolved", id: "q0" });
		for (const record of accepted) writer.enqueue("s", record);
		const plain = heldPeer(writer, "plain");
		const placeholders = heldPeer(writer, "placeholders", [MEDIA_PLACEHOLDERS_CAPABILITY]);
		writer.attachConnectionToSession("plain", "s");
		writer.attachConnectionToSession("placeholders", "s");
		plain.release();
		placeholders.release();
		await writer.flush();
		const tagged = accepted.map((record) => ({ ...record, sessionId: "s" }));
		const question = { ...tagged[4], remainingMs: 5_000 };
		const reference = [...tagged.slice(0, 4), question];
		expect(plain.lines).toEqual(reference.map((record) => serializeJsonLine(record)));
		expect(placeholders.lines).toEqual(reference.map((record) => serializeJsonLine(omitNormalInlineMedia(record))));
		expect(placeholders.lines[3]).toContain('"image_ref"');
		for (const id of ["live", "plain", "placeholders"]) writer.unregisterConnection(id);
	} finally {
		vi.useRealTimers();
	}
});

it("Q4 audience: a late peer receives the still-open broadcast question once and never a targeted dialog", async () => {
	const writer = new SessionEventWriter(() => {});
	const first = heldPeer(writer, "first");
	first.release();
	writer.attachConnectionToSession("first", "s");
	writer.enqueue("s", { type: "message_start", message: { role: "assistant", content: [] } });
	writer.withConnection("first", () =>
		writer.enqueue("s", { type: "extension_ui_request", id: "private", method: "select", options: ["a"] }),
	);
	writer.enqueue("s", { type: "extension_ui_request", id: "q1", method: "question", questions: [] });
	const late = heldPeer(writer, "late");
	writer.attachConnectionToSession("late", "s");
	late.release();
	await writer.flush();
	expect(shape(late.lines)).toEqual(["s:message_start", "s:extension_ui_request"]);
	expect(late.lines.filter((line) => line.includes('"method":"select"'))).toHaveLength(0);
	expect(late.lines.filter((line) => line.includes('"id":"q1"'))).toHaveLength(1);
	writer.unregisterConnection("first");
	writer.unregisterConnection("late");
});
