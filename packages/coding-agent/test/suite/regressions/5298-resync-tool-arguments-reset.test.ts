import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { EVENT_RESYNC_CAPABILITY } from "../../../src/modes/rpc/socket-peer-recovery.ts";
import { LaneProducer, update, usage } from "./4272-legacy-view-support.ts";

// #5298 (part of #4272, RULING-115 (b)): a compact cut taken while tool calls stream carries only their parsed
// arguments, so for every tool block open at the cut the peer gets `message_tool_arguments_reset` after the cut and
// before any later delta of that block, then one delta carrying the whole raw prefix; a block ended at the cut gets none.

beforeEach(() => vi.stubEnv("SENPI_ENGINE_SOCKET_COMPACT_UPDATES", "1"));
afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

const start = { role: "assistant", content: [], api: "faux", provider: "faux", model: "fixture", usage };
type Frame = {
	type: string;
	sessionId?: string;
	message?: { content?: { type: string; arguments?: unknown }[] } | null;
	contentIndex?: number;
	rawArgumentPrefix?: string;
	parsedThrough?: number;
	assistantMessageEvent?: { type: string; contentIndex: number; delta?: string; toolCall?: { arguments: unknown } };
};

class ToolStream {
	readonly raw = new Map<number, string>();
	private readonly producer: LaneProducer;

	constructor(producer: LaneProducer) {
		this.producer = producer;
	}

	start(contentIndex: number): void {
		const id = `call-${contentIndex}`;
		const block = { type: "toolCall", id, name: "bash", arguments: {} };
		this.raw.set(contentIndex, "");
		this.producer.assistant(
			update({ type: "toolcall_start", contentIndex, id, toolName: "bash" }),
			update({
				type: "toolcall_start",
				contentIndex,
				id,
				toolName: "bash",
				seed: { block, rawArgumentPrefix: "", parsedThrough: 0, coveredCodeUnits: 0, nextOffset: 0 },
			}),
		);
	}

	delta(contentIndex: number, delta: string): void {
		const offset = this.raw.get(contentIndex)?.length ?? 0;
		this.raw.set(contentIndex, (this.raw.get(contentIndex) ?? "") + delta);
		this.producer.assistant(
			update({ type: "toolcall_delta", contentIndex, delta }),
			update({ type: "toolcall_delta", contentIndex, delta, offset, parsedThrough: offset + delta.length }),
		);
	}

	end(contentIndex: number): { arguments: unknown } {
		const toolCall = {
			type: "toolCall",
			id: `call-${contentIndex}`,
			name: "bash",
			arguments: JSON.parse(this.raw.get(contentIndex) ?? ""),
		};
		this.producer.assistant(
			update({ type: "toolcall_end", contentIndex, toolCall }),
			update({ type: "toolcall_end", contentIndex, toolCall }),
		);
		return toolCall;
	}
}

/** A consumer that follows docs/rpc.md: the cut replaces its baseline, a reset replaces raw, a delta appends. */
function replayAfterCut(frames: readonly Frame[]) {
	const raw = new Map<number, string>();
	const reset = new Set<number>();
	const previews = new Map<number, string[]>();
	const deltaBeforeReset: number[] = [];
	const resets: Frame[] = [];
	const ends = new Map<number, unknown>();
	for (const frame of frames) {
		if (frame.type === "resync_required" && frame.sessionId === "s") {
			for (const [index, block] of (frame.message?.content ?? []).entries())
				if (block?.type === "toolCall") raw.set(index, "");
			continue;
		}
		if (frame.type === "message_tool_arguments_reset" && frame.contentIndex !== undefined) {
			resets.push(frame);
			reset.add(frame.contentIndex);
			raw.set(frame.contentIndex, frame.rawArgumentPrefix ?? "");
			continue;
		}
		const event = frame.assistantMessageEvent;
		if (frame.type !== "message_update" || !event) continue;
		if (event.type === "toolcall_delta") {
			if (!reset.has(event.contentIndex)) deltaBeforeReset.push(event.contentIndex);
			raw.set(event.contentIndex, (raw.get(event.contentIndex) ?? "") + (event.delta ?? ""));
			previews.set(event.contentIndex, [
				...(previews.get(event.contentIndex) ?? []),
				raw.get(event.contentIndex) ?? "",
			]);
		}
		if (event.type === "toolcall_end") ends.set(event.contentIndex, event.toolCall?.arguments);
	}
	return { previews, deltaBeforeReset, resets, ends };
}

it("RULING-115: every tool block open at a cut is reset after it, then resumes from offset 0 with the whole raw prefix", async () => {
	vi.useFakeTimers();
	const writer = new SessionEventWriter(() => {});
	const frames: Frame[] = [];
	let blocked = false;
	const drain = Promise.withResolvers<void>();
	writer.registerConnection(
		"peer",
		{
			writeRaw: (line) => void frames.push(JSON.parse(line) as Frame),
			waitForBackpressure: () => (blocked ? drain.promise : Promise.resolve()),
		},
		{ maxQueueBytes: 2_000 },
	);
	writer.setConnectionCapabilities("peer", [EVENT_RESYNC_CAPABILITY]);
	const lane = new SessionAcceptanceLane();
	lane.bootstrap({ transcript: [] });
	writer.registerAcceptance("s", lane);
	writer.attachConnectionToSession("peer", "s");
	await writer.flush();

	const producer = new LaneProducer(writer, lane, "s");
	const tools = new ToolStream(producer);
	producer.assistant({ type: "message_start", message: start }, { type: "message_start", message: start });
	await writer.flush();
	let ended: { arguments: unknown } | undefined;
	for (const step of [
		() => tools.start(0),
		() => tools.delta(0, '{"command":"ls"}'),
		() => {
			ended = tools.end(0);
		},
		() => tools.start(1),
		() => tools.start(2),
		() => tools.delta(1, '{"command":"'),
		() => tools.delta(2, '{"command":"'),
	]) {
		step();
		await writer.flush();
	}
	expect(lane.liveRoots, "nothing shed before the hold").toBe(0);

	blocked = true;
	for (let step = 0; step < 400 && lane.liveRoots === 0; step++) tools.delta(1 + (step % 2), "x");
	expect(lane.liveRoots, "the shed froze C").toBe(1);
	const atC = new Map([1, 2].map((index) => [index, tools.raw.get(index) ?? ""]));
	const truth = new Map<number, string[]>([
		[1, [atC.get(1) ?? ""]],
		[2, [atC.get(2) ?? ""]],
	]);
	for (const piece of ["y", "yy", '"}']) {
		for (const index of [1, 2]) {
			tools.delta(index, piece);
			truth.get(index)?.push(tools.raw.get(index) ?? "");
		}
	}
	const finals = [tools.end(1), tools.end(2)];
	blocked = false;
	drain.resolve();
	await writer.flush();

	const cuts = frames.filter((frame) => frame.type === "resync_required" && frame.sessionId === "s");
	expect(cuts, "one cut, its captured suffix not superseded").toHaveLength(1);
	const cut = frames.indexOf(cuts[0]);
	const after = frames.slice(cut);
	const replay = replayAfterCut(after);

	// (1) Ordering: no delta of an open block reaches the consumer between the cut and its reset.
	expect(replay.deltaBeforeReset).toEqual([]);
	// (3) One reset per block open at the cut, none for the block that had already ended.
	expect(replay.resets.map((frame) => frame.contentIndex).sort()).toEqual([1, 2]);
	for (const frame of replay.resets) expect(frame).toMatchObject({ rawArgumentPrefix: "", parsedThrough: 0 });
	// (2) Content: the first delta after the reset is the whole raw prefix at C, and the preview equals the raw
	// argument stream at every later step.
	expect(replay.previews.get(1)).toEqual(truth.get(1));
	expect(replay.previews.get(2)).toEqual(truth.get(2));
	expect(replay.previews.has(0)).toBe(false);
	expect(replay.ends.get(1)).toEqual(finals[0].arguments);
	expect(replay.ends.get(2)).toEqual(finals[1].arguments);
	expect(ended?.arguments).toEqual({ command: "ls" });

	expect(lane.liveRoots).toBe(0);
	writer.unregisterConnection("peer");
	lane.retire("close");
	await lane.idle();
});
