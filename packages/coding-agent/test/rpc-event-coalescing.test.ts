import { describe, expect, it } from "vitest";
import { createRpcEventOutputBuffer } from "../src/modes/rpc/event-output-buffer.ts";

function parseLines(chunks: readonly string[]): Array<Record<string, unknown>> {
	return chunks
		.join("")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("RPC event output coalescing", () => {
	it("flushes pending events before immediate response writes", () => {
		const chunks: string[] = [];
		const scheduled: Array<() => void> = [];
		const buffer = createRpcEventOutputBuffer(
			(chunk) => chunks.push(chunk),
			(flush) => scheduled.push(flush),
		);

		buffer.enqueueEvent({ type: "event", sequence: 1 });
		buffer.enqueueEvent({ type: "event", sequence: 2 });
		buffer.writeImmediate({ type: "response", id: "cmd-1" });

		expect(chunks).toHaveLength(2);
		expect(parseLines(chunks)).toEqual([
			{ type: "event", sequence: 1 },
			{ type: "event", sequence: 2 },
			{ type: "response", id: "cmd-1" },
		]);
	});

	it("coalesces same-tick events into one raw write", () => {
		const chunks: string[] = [];
		const scheduled: Array<() => void> = [];
		const buffer = createRpcEventOutputBuffer(
			(chunk) => chunks.push(chunk),
			(flush) => scheduled.push(flush),
		);

		buffer.enqueueEvent({ type: "event", sequence: 1 });
		buffer.enqueueEvent({ type: "event", sequence: 2 });
		buffer.enqueueEvent({ type: "event", sequence: 3 });
		scheduled[0]();

		expect(chunks).toHaveLength(1);
		expect(parseLines(chunks)).toEqual([
			{ type: "event", sequence: 1 },
			{ type: "event", sequence: 2 },
			{ type: "event", sequence: 3 },
		]);
	});

	it("does not merge extension UI requests or responses into event batches", () => {
		const chunks: string[] = [];
		const scheduled: Array<() => void> = [];
		const buffer = createRpcEventOutputBuffer(
			(chunk) => chunks.push(chunk),
			(flush) => scheduled.push(flush),
		);

		buffer.enqueueEvent({ type: "message_update", sequence: 1 });
		buffer.writeImmediate({ type: "extension_ui_request", id: "ui-1" });
		buffer.writeImmediate({ type: "response", id: "cmd-1" });

		expect(chunks).toHaveLength(3);
		expect(parseLines([chunks[0]])).toEqual([{ type: "message_update", sequence: 1 }]);
		expect(parseLines([chunks[1]])).toEqual([{ type: "extension_ui_request", id: "ui-1" }]);
		expect(parseLines([chunks[2]])).toEqual([{ type: "response", id: "cmd-1" }]);
	});

	it("flushes tail events on explicit flush", () => {
		const chunks: string[] = [];
		const scheduled: Array<() => void> = [];
		const buffer = createRpcEventOutputBuffer(
			(chunk) => chunks.push(chunk),
			(flush) => scheduled.push(flush),
		);

		buffer.enqueueEvent({ type: "event", sequence: 1 });
		buffer.flushEvents();

		expect(chunks).toHaveLength(1);
		expect(parseLines(chunks)).toEqual([{ type: "event", sequence: 1 }]);
	});
});
