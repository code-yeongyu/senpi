import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessageEvent } from "../src/types.ts";
import { RecoveryAssistantMessageEventStream } from "../src/tool-call-middleware/recovery-event-stream.ts";
import { assistantRecords, getAssistantCapture, subscribeAssistantCapture } from "../src/utils/assistant-capture.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";
import { createAssistantMessage } from "./tool-call-middleware/stream-wrapper-fixtures.ts";

let release = () => {};
beforeEach(() => {
	release = subscribeAssistantCapture();
});
afterEach(() => {
	release();
	vi.restoreAllMocks();
});

function startAt(offset: number) {
	const partial = createAssistantMessage([{ type: "text", text: "Hé" }]);
	const stream = new AssistantMessageEventStream({ captureBlocks: true });
	const start: AssistantMessageEvent = { type: "text_start", contentIndex: 0, partial };
	stream.push(start, { offset });
	const delta: AssistantMessageEvent = { type: "text_delta", contentIndex: 0, delta: "", partial };
	stream.push(delta);
	stream.end(partial);
	return { start, delta };
}

describe("producer seed emission frontier #4272", () => {
	it("distinguishes identical replay and continuation seeds before any delta is read", () => {
		const replay = startAt(0);
		const continuation = startAt(2);
		expect(getAssistantCapture(replay.start)).toMatchObject({ coveredCodeUnits: 2, nextOffset: 0 });
		expect(getAssistantCapture(continuation.start)).toMatchObject({ coveredCodeUnits: 2, nextOffset: 2 });
		expect(getAssistantCapture(replay.delta)?.offset).toBe(0);
		expect(getAssistantCapture(continuation.delta)?.offset).toBe(2);
	});

	it.each([0, 2])("relays the producer frontier %s rather than the later partial length", async (offset) => {
		const source = startAt(offset);
		const partial = createAssistantMessage([{ type: "text", text: "later bytes" }]);
		const relay = new RecoveryAssistantMessageEventStream();
		relay.relaying(source.start, () => relay.push({ type: "text_start", contentIndex: 0, partial }));
		relay.end(partial);
		const records = [];
		for await (const record of assistantRecords(relay)) records.push(record);
		expect(getAssistantCapture(records[0] ?? {})).toMatchObject({
			block: { text: "Hé" },
			coveredCodeUnits: 2,
			nextOffset: offset,
		});
	});

	it.each([-1, 1, 3, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects unsupported producer frontier %s without disrupting the legacy stream",
		(offset) => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const { start, delta } = startAt(offset);
			expect(getAssistantCapture(start)).toBeUndefined();
			expect(getAssistantCapture(delta)).toBeUndefined();
			expect(warn).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ name: "SeedFrontierError", code: "invalid_next_offset" }),
			);
		},
	);
});
