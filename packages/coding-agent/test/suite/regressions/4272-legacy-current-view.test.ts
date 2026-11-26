import { afterEach, expect, it, vi } from "vitest";
import { MEDIA_PLACEHOLDERS_CAPABILITY } from "../../../src/modes/rpc/custom-capability.ts";
import { serializeJsonLine } from "../../../src/modes/rpc/jsonl.ts";
import { LegacyReplayStore } from "../../../src/modes/rpc/legacy-replay-store.ts";
import { omitNormalInlineMedia } from "../../../src/modes/rpc/media-placeholders.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { LaneProducer, update, usage } from "./4272-legacy-view-support.ts";

// Part of #4272 (S07b, R3.C6.4, RULING-25 Q1-Q5): a late peer's baseline is rebuilt from the frozen compact
// current-state view of the session's lane, never from a retained replay of its records.

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

type Peer = { readonly lines: string[]; release(): void };

function heldPeer(writer: SessionEventWriter, id: string, capabilities: readonly string[] = []): Peer {
	const lines: string[] = [];
	let released = false;
	const waiters: (() => void)[] = [];
	writer.registerConnection(id, {
		writeRaw: (chunk) => void lines.push(chunk),
		waitForBackpressure: () =>
			released ? Promise.resolve() : new Promise<void>((resolve) => void waiters.push(resolve)),
	});
	if (capabilities.length > 0) writer.setConnectionCapabilities(id, capabilities);
	return {
		lines,
		release: () => {
			released = true;
			for (const resolve of waiters.splice(0)) resolve();
		},
	};
}

const start = {
	role: "assistant",
	content: [],
	api: "faux",
	provider: "faux",
	model: "fixture",
	timestamp: 1,
	stopReason: "stop",
	usage,
};
const call = { type: "toolCall", id: "c1", name: "read", arguments: { a: 1 } };
const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
const question = { type: "extension_ui_request", id: "q1", method: "question", questions: [], deadlineAtMs: 6_000 };

/** The reference a legacy consumer expects at C: lifecycle, the current message as starts and prefix deltas, open questions. */
const reference = [
	{ type: "session_lifecycle", state: "running" },
	{
		type: "message_start",
		message: { ...start, content: [{ type: "text", text: "" }, { type: "thinking", thinking: "" }, call] },
	},
	update({ type: "text_start", contentIndex: 0 }),
	update({ type: "text_delta", contentIndex: 0, delta: "hello" }),
	update({ type: "thinking_start", contentIndex: 1 }),
	update({ type: "thinking_delta", contentIndex: 1, delta: "hm" }),
	update({ type: "thinking_end", contentIndex: 1, content: "hm" }),
	update({ type: "toolcall_start", contentIndex: 2, id: "c1", toolName: "read" }),
	update({ type: "toolcall_delta", contentIndex: 2, delta: '{"a":1}' }),
	update({ type: "toolcall_end", contentIndex: 2, toolCall: call }),
	{ ...question, sessionId: "s", remainingMs: 5_000 },
].map((record) => ({ ...record, sessionId: "s" }));

/** One lane-owned session streamed to C, with effects, a settled question and a targeted dialog between start and C. */
function sessionAtC() {
	vi.useFakeTimers({ now: 1_000 });
	const writer = new SessionEventWriter(() => {});
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: [] });
	writer.registerAcceptance("s", lane);
	const live = heldPeer(writer, "live");
	live.release();
	writer.attachConnectionToSession("live", "s");
	const producer = new LaneProducer(writer, lane, "s");
	producer.record({ type: "session_lifecycle", state: "running" });
	producer.assistant({ type: "message_start", message: start }, { type: "message_start", message: start });
	producer.blockStart("text", 0);
	producer.blockDelta("text", 0, "hel", 0);
	producer.record({ type: "tool_execution_start", toolCallId: "c0", toolName: "read", args: {} });
	producer.record({
		type: "tool_execution_end",
		toolCallId: "c0",
		result: { role: "toolResult", toolCallId: "c0", content: [image] },
	});
	producer.blockDelta("text", 0, "lo", 3);
	producer.blockStart("thinking", 1);
	producer.blockDelta("thinking", 1, "hm", 0);
	producer.blockEnd("thinking", 1, "hm");
	const seed = {
		block: { ...call, arguments: {} },
		rawArgumentPrefix: "",
		parsedThrough: 0,
		coveredCodeUnits: 0,
		nextOffset: 0,
	};
	producer.assistant(
		update({ type: "toolcall_start", contentIndex: 2, id: "c1", toolName: "read" }),
		update({ type: "toolcall_start", contentIndex: 2, id: "c1", toolName: "read", seed }),
	);
	producer.assistant(
		update({ type: "toolcall_delta", contentIndex: 2, delta: '{"a":1}' }),
		update({ type: "toolcall_delta", contentIndex: 2, delta: '{"a":1}', offset: 0, parsedThrough: 7 }),
	);
	producer.assistant(
		update({ type: "toolcall_end", contentIndex: 2, toolCall: call }),
		update({ type: "toolcall_end", contentIndex: 2, toolCall: call }),
	);
	producer.record({ type: "entry_appended", entry: { type: "message", id: "e1" } });
	producer.record({ type: "extension_ui_request", id: "q0", method: "question", questions: [] });
	producer.record({ type: "question_resolved", id: "q0" });
	producer.record(question);
	const targeted = { type: "extension_ui_request", id: "t1", method: "select", title: "private", options: [] };
	lane.accept(targeted, undefined);
	writer.withConnection("live", () => writer.enqueue("s", targeted));
	return { writer, lane, live };
}

it("Q2 T6-L2 Q4: a late peer gets the current view as starts plus prefix deltas, no effect record, no targeted dialog; each frame equals the legacy-shaped reference (plain and placeholder variants)", async () => {
	const remember = vi.spyOn(LegacyReplayStore.prototype, "remember");
	const { writer, lane, live } = sessionAtC();
	const plain = heldPeer(writer, "plain");
	const placeholders = heldPeer(writer, "placeholders", [MEDIA_PLACEHOLDERS_CAPABILITY]);
	writer.attachConnectionToSession("plain", "s");
	writer.attachConnectionToSession("placeholders", "s");
	expect(lane.liveRoots, "both attaches froze the session's root").toBe(2);
	plain.release();
	placeholders.release();
	await writer.flush();
	expect(plain.lines).toEqual(reference.map((record) => serializeJsonLine(record)));
	expect(placeholders.lines).toEqual(reference.map((record) => serializeJsonLine(omitNormalInlineMedia(record))));
	expect(plain.lines.join("")).not.toMatch(/tool_execution|entry_appended|"q0"|"select"|private/);
	// X07: the lane-owned session retained nothing for replay; the live peer kept today's bytes for every record.
	expect(remember.mock.calls.filter(([sessionId]) => sessionId === "s")).toHaveLength(0);
	expect(live.lines.filter((line) => line.includes('"tool_execution_end"'))).toHaveLength(1);
	expect(writer.openLegacyViews).toBe(0);
	expect(lane.liveRoots).toBe(0);
	for (const id of ["live", "plain", "placeholders"]) writer.unregisterConnection(id);
	lane.retire("close");
	await lane.idle();
});

it("T6-L1 display fold: a consumer applying starts and prefix deltas holds the accepted content, every prefix exactly once", async () => {
	const { writer, lane } = sessionAtC();
	const late = heldPeer(writer, "late");
	writer.attachConnectionToSession("late", "s");
	late.release();
	await writer.flush();
	const content: Record<string, unknown>[] = [];
	const raw = new Map<number, string>();
	const deltas = new Map<number, number>();
	for (const line of late.lines) {
		const record = JSON.parse(line) as {
			type: string;
			message?: { content: Record<string, unknown>[] };
			assistantMessageEvent?: Record<string, unknown>;
		};
		if (record.type === "message_start" && record.message) content.push(...record.message.content);
		const event = record.assistantMessageEvent;
		if (!event) continue;
		const index = Number(event.contentIndex);
		const block = content[index] ?? {};
		if (event.type === "text_delta") block.text = `${block.text}${event.delta}`;
		if (event.type === "thinking_delta") block.thinking = `${block.thinking}${event.delta}`;
		if (event.type === "toolcall_delta") raw.set(index, `${raw.get(index) ?? ""}${event.delta}`);
		if (event.type === "toolcall_end") content[index] = event.toolCall as Record<string, unknown>;
		if (String(event.type).endsWith("_delta")) deltas.set(index, (deltas.get(index) ?? 0) + 1);
	}
	expect(content).toEqual([{ type: "text", text: "hello" }, { type: "thinking", thinking: "hm" }, call]);
	expect(raw.get(2)).toBe('{"a":1}');
	expect([...deltas.values()]).toEqual([1, 1, 1]);
	for (const id of ["live", "late"]) writer.unregisterConnection(id);
	lane.retire("close");
	await lane.idle();
});

it("a lane whose compact state became unavailable installs no baseline, keeps the peer open and delivers the live suffix", async () => {
	const writer = new SessionEventWriter(() => {});
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: [] });
	writer.registerAcceptance("s", lane);
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	const producer = new LaneProducer(writer, lane, "s");
	producer.assistant({ type: "message_start", message: start }, { type: "message_start", message: start });
	lane.compactUnavailable(new Error("lost canonical record"));
	const late = heldPeer(writer, "late");
	writer.attachConnectionToSession("late", "s");
	expect(lane.liveRoots, "nothing readable was pinned").toBe(0);
	producer.blockStart("text", 0);
	late.release();
	await writer.flush();
	expect(late.lines).toEqual([
		serializeJsonLine({ ...update({ type: "text_start", contentIndex: 0 }), sessionId: "s" }),
	]);
	expect(writer.openLegacyViews).toBe(0);
	expect(stderr).toHaveBeenCalledTimes(1);
	writer.unregisterConnection("late");
	lane.retire("close");
	await lane.idle();
});

it("RULING-25 Q5: a session without a lane keeps today's retention, and says so nowhere else", async () => {
	const remember = vi.spyOn(LegacyReplayStore.prototype, "remember");
	const writer = new SessionEventWriter(() => {});
	writer.enqueue("external", { type: "message_start", message: start });
	const late = heldPeer(writer, "late");
	writer.attachConnectionToSession("late", "external");
	late.release();
	await writer.flush();
	expect(remember).toHaveBeenCalledTimes(1);
	expect(late.lines).toEqual([serializeJsonLine({ type: "message_start", message: start, sessionId: "external" })]);
	writer.unregisterConnection("late");
});
