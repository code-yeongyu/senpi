import { expect, it } from "vitest";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { usage } from "./4272-legacy-view-support.ts";

// senpi#4239: with the compact-updates flag off no session owns an acceptance lane, so every in-flight message is
// retained by the legacy replay store for late peers. It kept every cumulative `message_update` line until
// `message_end`, so one streamed message held the sum of all its partials (quadratic in the stream) per session on the
// shared host. Retention must stay linear: every delta in order, one cumulative snapshot (the newest).

const COUNT = 1000;
const DELTA = "x".repeat(32);

type Line = {
	type: string;
	message?: unknown;
	assistantMessageEvent?: { type: string; delta?: string; partial?: unknown };
};

const message = (text: string) => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "faux",
	provider: "faux",
	model: "fixture",
	timestamp: 1,
	stopReason: "stop",
	usage,
});

const updateAt = (index: number) => ({
	type: "message_update",
	message: message(DELTA.repeat(index)),
	assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: DELTA, partial: message(DELTA.repeat(index)) },
});

function peer(writer: SessionEventWriter, id: string) {
	const lines: string[] = [];
	let released = false;
	const waiters: (() => void)[] = [];
	writer.registerConnection(id, {
		writeRaw: (chunk) => void lines.push(...chunk.split("\n").filter((line) => line !== "")),
		waitForBackpressure: () =>
			released ? Promise.resolve() : new Promise<void>((resolve) => void waiters.push(resolve)),
	});
	return {
		lines,
		parsed: () => lines.map((line) => JSON.parse(line) as Line),
		release: () => {
			released = true;
			for (const resolve of waiters.splice(0)) resolve();
		},
	};
}

function streamTo(writer: SessionEventWriter, from: number, to: number): void {
	for (let index = from; index <= to; index++) writer.enqueue("s", updateAt(index));
}

function startMessage(writer: SessionEventWriter): void {
	writer.enqueue("s", { type: "message_start", message: message("") });
	writer.enqueue("s", {
		type: "message_update",
		message: message(""),
		assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: message("") },
	});
}

const fullDeltas = (records: Line[]) =>
	records.filter((record) => record.assistantMessageEvent?.type === "text_delta" && record.message != null);

it("a late peer's replay of an in-flight message is linear: every delta, one cumulative snapshot, the live message", async () => {
	const writer = new SessionEventWriter(() => {});
	startMessage(writer);
	streamTo(writer, 1, COUNT);

	const late = peer(writer, "late");
	writer.attachConnectionToSession("late", "s");
	late.release();
	await writer.flush();
	const records = late.parsed();
	const deltas = records.filter((record) => record.assistantMessageEvent?.type === "text_delta");

	expect(deltas.map((record) => record.assistantMessageEvent?.delta).join("")).toBe(DELTA.repeat(COUNT));
	expect(fullDeltas(records)).toHaveLength(1);
	expect(JSON.stringify(deltas.at(-1)?.message)).toBe(JSON.stringify(updateAt(COUNT).message));
	expect(JSON.stringify(deltas.at(-1)?.assistantMessageEvent?.partial)).toBe(JSON.stringify(updateAt(COUNT).message));
	const bytes = late.lines.reduce((total, line) => total + Buffer.byteLength(line), 0);
	expect(bytes).toBeLessThan(COUNT * 1024);
	writer.unregisterConnection("late");
});

it("records that carry no message never supersede the snapshot: the newest delta stays whole after tool events", async () => {
	const writer = new SessionEventWriter(() => {});
	startMessage(writer);
	for (let index = 1; index <= 50; index++) {
		writer.enqueue("s", updateAt(index));
		writer.enqueue("s", { type: "tool_execution_update", toolCallId: "t", partialResult: { index } });
	}

	const late = peer(writer, "late");
	writer.attachConnectionToSession("late", "s");
	late.release();
	await writer.flush();
	const full = fullDeltas(late.parsed());

	expect(full).toHaveLength(1);
	expect(JSON.stringify(full[0]?.message)).toBe(JSON.stringify(updateAt(50).message));
	writer.unregisterConnection("late");
});

it("a baseline frozen mid-stream still reads the cumulative snapshot it froze while later updates supersede it", async () => {
	const writer = new SessionEventWriter(() => {});
	startMessage(writer);
	streamTo(writer, 1, 10);

	const late = peer(writer, "late");
	writer.attachConnectionToSession("late", "s");
	streamTo(writer, 11, 20);
	late.release();
	await writer.flush();
	const deltas = late.parsed().filter((record) => record.assistantMessageEvent?.type === "text_delta");

	expect(deltas.map((record) => record.assistantMessageEvent?.delta).join("")).toBe(DELTA.repeat(20));
	const frozen = deltas.find((record) => JSON.stringify(record.message) === JSON.stringify(updateAt(10).message));
	expect(frozen, "the frozen baseline's newest snapshot was rewritten after the freeze").toBeDefined();
	writer.unregisterConnection("late");
});
