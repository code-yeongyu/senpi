import { afterEach, expect, it, vi } from "vitest";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { SessionEventFanout } from "../../../src/modes/rpc/session-event-fanout.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { deriveSessionStatus } from "../../../src/modes/rpc/session-status.ts";
import { LaneProducer, update, usage } from "./4272-legacy-view-support.ts";

// Part of #4272 (S07b, RULING-25 Q1): a lane-owned session's rebuilt view keeps the resolved tool identity the live
// frames carry, status never reads an unavailable lane as zero open questions, and a cancelled view stays quiet.

afterEach(() => {
	vi.restoreAllMocks();
});

const start = { role: "assistant", content: [], api: "faux", provider: "faux", model: "fixture", timestamp: 1, usage };
const question = { type: "extension_ui_request", id: "q1", method: "question", questions: [] };

function peer(writer: SessionEventWriter, id: string): string[] {
	const lines: string[] = [];
	writer.registerConnection(id, { writeRaw: (chunk) => void lines.push(chunk), waitForBackpressure: async () => {} });
	return lines;
}

function laneSession() {
	const writer = new SessionEventWriter(() => {});
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: [] });
	writer.registerAcceptance("s", lane);
	const producer = new LaneProducer(writer, lane, "s");
	producer.assistant({ type: "message_start", message: start }, { type: "message_start", message: start });
	return { writer, lane, producer };
}

it("Q1 resolved identity: a late peer's rebuilt toolcall_start and toolcall_end carry the live frames' resolvedToolName (alias-resolved tool)", async () => {
	const writer = new SessionEventWriter(() => {});
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: [] });
	writer.registerAcceptance("s", lane);
	const live = peer(writer, "live");
	writer.attachConnectionToSession("live", "s");
	const producer = new LaneProducer(writer, lane, "s");
	const aliased = { type: "toolCall", id: "c1", name: "rd", arguments: {} };
	const resolved = { resolvedToolName: "read" };
	const seed = { block: aliased, rawArgumentPrefix: "", parsedThrough: 0, coveredCodeUnits: 0, nextOffset: 0 };
	producer.assistant({ type: "message_start", message: start }, { type: "message_start", message: start });
	producer.assistant(
		update({ type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "rd" }, resolved),
		update({ type: "toolcall_start", contentIndex: 0, id: "c1", toolName: "rd", seed }, resolved),
	);
	producer.assistant(
		update({ type: "toolcall_end", contentIndex: 0, toolCall: aliased }, resolved),
		update({ type: "toolcall_end", contentIndex: 0, toolCall: aliased }, resolved),
	);
	const late = peer(writer, "late");
	writer.attachConnectionToSession("late", "s");
	await writer.flush();
	const toolFrames = (lines: readonly string[]) => lines.filter((line) => /"toolcall_(start|end)"/.test(line));
	expect(toolFrames(live)).toHaveLength(2);
	expect(toolFrames(late)).toEqual(toolFrames(live));
	for (const id of ["live", "late"]) writer.unregisterConnection(id);
	lane.retire("close");
	await lane.idle();
});

it("status: a lane whose compact state became unavailable reports an unknown pending-question count, never 0; the runtime's own count decides", async () => {
	const fanout = new SessionEventFanout();
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: [] });
	fanout.acceptance.set("s", lane);
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	lane.accept(question, undefined);
	expect(fanout.pendingQuestionCount("s"), "the lane's hot count").toBe(1);
	lane.compactUnavailable(new Error("lost canonical record"));
	expect(fanout.pendingQuestionCount("s"), "unknown, not the empty replay store's 0").toBeUndefined();
	const entry = { state: "open", kind: "interactive", cwd: "/w", attachments: 1, context: {} } as const;
	const runtime = { isStreaming: true, isCompacting: false, steering: 0, followUp: 0, pendingQuestions: 1 };
	const unknown = { pendingQuestions: fanout.pendingQuestionCount("s") };
	expect(deriveSessionStatus(entry, runtime, unknown).status).toBe("waiting_input");
	expect(deriveSessionStatus(entry, { ...runtime, pendingQuestions: 0 }, unknown).status).toBe("running");
	lane.retire("close");
	await lane.idle();
});

it.each(["peer drop", "replacement"] as const)(
	"a %s between the view's root reads ends it quietly: no 'current view unavailable' line, nothing written, nothing pinned",
	async (cause) => {
		const { writer, lane, producer } = laneSession();
		producer.blockStart("text", 0);
		producer.blockDelta("text", 0, "hi", 0);
		const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		const read = lane.readCurrentComponents.bind(lane);
		let cancelled = false;
		vi.spyOn(lane, "readCurrentComponents").mockImplementation(async (root) => {
			const components = await read(root);
			if (cause === "peer drop") writer.unregisterConnection("late");
			else lane.bootstrap({ transcript: [] });
			cancelled = true;
			return components;
		});
		const late = peer(writer, "late");
		writer.attachConnectionToSession("late", "s");
		await writer.flush();
		expect(cancelled, "the cancellation landed between the reads").toBe(true);
		expect(late).toEqual([]);
		expect(stderr.mock.calls.filter(([line]) => String(line).includes("current view unavailable"))).toEqual([]);
		expect(lane.liveRoots).toBe(0);
		expect(writer.openLegacyViews).toBe(0);
		writer.unregisterConnection("late");
		lane.retire("close");
		await lane.idle();
	},
);
