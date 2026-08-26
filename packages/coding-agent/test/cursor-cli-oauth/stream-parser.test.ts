import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type CursorCliStreamEvent,
	CursorCliStreamParser,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/stream-parser.ts";

const CAPTURE_ROOT = fileURLToPath(new URL("./fixtures/captures", import.meta.url));
const encoder = new TextEncoder();

function capture(name: string): Uint8Array {
	const stdout = readFileSync(`${CAPTURE_ROOT}/${name}`, "utf8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => line.replace(/^\S+ /, ""))
		.join("\n");
	return encoder.encode(`${stdout}\n`);
}

function oneByteChunks(bytes: Uint8Array): Uint8Array[] {
	return Array.from(bytes, (_, index) => bytes.subarray(index, index + 1));
}

function midJsonChunks(bytes: Uint8Array): Uint8Array[] {
	const chunks: Uint8Array[] = [];
	let start = 0;
	let width = 17;
	while (start < bytes.length) {
		const end = Math.min(bytes.length, start + width);
		chunks.push(bytes.subarray(start, end));
		start = end;
		width = width === 17 ? 113 : 17;
	}
	return chunks;
}

function parse(chunks: readonly Uint8Array[]): {
	events: CursorCliStreamEvent[];
	diagnostics: readonly string[];
	unknownEventCount: number;
} {
	const parser = new CursorCliStreamParser();
	const events: CursorCliStreamEvent[] = [];
	for (const chunk of chunks) events.push(...parser.push(chunk));
	events.push(...parser.finish());
	return { events, diagnostics: parser.diagnostics, unknownEventCount: parser.unknownEventCount };
}

function eventsOfType<T extends CursorCliStreamEvent["type"]>(
	events: readonly CursorCliStreamEvent[],
	type: T,
): Array<Extract<CursorCliStreamEvent, { type: T }>> {
	return events.filter((event): event is Extract<CursorCliStreamEvent, { type: T }> => event.type === type);
}

describe("CursorCliStreamParser", () => {
	for (const name of ["run-a-events.jsonl", "run-d-force.jsonl", "run-c-noforce.jsonl", "run-f-events.jsonl"]) {
		it(`replays ${name} identically across adversarial chunk boundaries`, () => {
			const bytes = capture(name);
			const baseline = parse([bytes]);
			expect(parse(oneByteChunks(bytes))).toEqual(baseline);
			expect(parse(midJsonChunks(bytes))).toEqual(baseline);
			expect(baseline.events.at(-1)?.type).toBe("result");
			expect(baseline.events).not.toContainEqual(expect.objectContaining({ type: "malformed_stream" }));
		});
	}

	it("extracts init, incremental assistant, thinking, and result fields from the real dialect", () => {
		const parsed = parse([capture("run-a-events.jsonl")]);
		const init = eventsOfType(parsed.events, "system")[0];
		expect(init).toEqual({
			type: "system",
			subtype: "init",
			session_id: "14e3d8df-06e5-48d5-a1de-00edae06bddd",
			model: "Composer 2.5 Fast",
			apiKeySource: "login",
			permissionMode: "default",
			cwd: "/private/tmp/cursor-p-qa",
		});
		expect(eventsOfType(parsed.events, "thinking")).toHaveLength(15);
		expect(eventsOfType(parsed.events, "assistant")).toHaveLength(7);
		expect(eventsOfType(parsed.events, "assistant")[0]?.message.content[0]?.text).toBe("STREAM");
		expect(eventsOfType(parsed.events, "result")[0]).toEqual(
			expect.objectContaining({
				subtype: "success",
				request_id: "def10c08-cbc4-403a-87a7-71a789bedc3d",
				duration_ms: 7296,
				is_error: false,
				usage: { inputTokens: 10389, outputTokens: 642, cacheReadTokens: 8928, cacheWriteTokens: 0 },
			}),
		);
	});

	it("extracts successful and rejected tool results from real captures", () => {
		const forced = parse([capture("run-d-force.jsonl")]);
		const completed = eventsOfType(forced.events, "tool_call").find((event) => event.subtype === "completed");
		expect(completed?.tool_call.shellToolCall?.result).toEqual({
			success: { exitCode: 0, stdout: "tooltest-force-77\n", stderr: "", executionTime: 1299 },
		});

		const rejected = parse([capture("run-c-noforce.jsonl")]);
		const rejection = eventsOfType(rejected.events, "tool_call").find((event) => {
			const result = event.tool_call.shellToolCall?.result;
			return event.subtype === "completed" && result !== undefined && "rejected" in result;
		});
		expect(rejection?.tool_call.shellToolCall?.result).toEqual({
			rejected: { command: "echo tooltest-42", reason: "", isReadonly: false },
		});
	});

	it("preserves all 188 incremental assistant fragments", () => {
		const parsed = parse([capture("run-f-events.jsonl")]);
		expect(eventsOfType(parsed.events, "assistant")).toHaveLength(188);
	});

	it("emits malformed_stream for truncated tails and garbage without throwing", () => {
		const truncated = new CursorCliStreamParser();
		expect(() => truncated.push(encoder.encode('{"type":"assistant","message":'))).not.toThrow();
		expect(truncated.finish()).toContainEqual(expect.objectContaining({ type: "malformed_stream" }));

		const garbage = parse([
			encoder.encode(
				'cursor-agent banner\n{"type":"result","subtype":"error","result":"bad","usage":{"inputTokens":1,"outputTokens":2,"cacheReadTokens":3,"cacheWriteTokens":4},"request_id":"req","duration_ms":5,"is_error":true}\n',
			),
		]);
		expect(garbage.events).toContainEqual(expect.objectContaining({ type: "malformed_stream" }));
		expect(garbage.diagnostics).toEqual(["cursor-agent banner"]);
	});

	it("counts unknown event types without throwing or emitting them", () => {
		const parsed = parse([
			encoder.encode(
				'{"type":"future_event","payload":true}\n{"type":"result","subtype":"success","result":"ok","usage":{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0},"request_id":"req","duration_ms":1,"is_error":false}\n',
			),
		]);
		expect(parsed.unknownEventCount).toBe(1);
		expect(parsed.events).toHaveLength(1);
		expect(parsed.events[0]?.type).toBe("result");
	});

	it("bounds pending lines and the diagnostic ring", () => {
		const parser = new CursorCliStreamParser({ maxPendingBytes: 32, maxDiagnostics: 2, maxDiagnosticCharacters: 8 });
		const events = parser.push(encoder.encode(`${"x".repeat(40)}\nfirst garbage\nsecond garbage\nthird garbage\n`));
		events.push(...parser.finish());
		expect(events.filter((event) => event.type === "malformed_stream").length).toBeGreaterThanOrEqual(4);
		expect(parser.diagnostics).toEqual(["second g", "third ga"]);
	});

	it("marks a stream without a result event incomplete instead of successful", () => {
		const parsed = parse([
			encoder.encode('{"type":"assistant","message":{"content":[{"type":"text","text":"looks successful"}]}}\n'),
		]);
		expect(parsed.events.at(-1)).toEqual(
			expect.objectContaining({ type: "malformed_stream", reason: "incomplete_stream" }),
		);
	});

	it("does not leak buffered state when reused for another run", () => {
		const parser = new CursorCliStreamParser();
		parser.push(encoder.encode('{"type":"assistant"'));
		expect(parser.finish()).toContainEqual(expect.objectContaining({ type: "malformed_stream" }));

		const nextEvents = parser.push(
			encoder.encode(
				'{"type":"result","subtype":"success","result":"fresh","usage":{"inputTokens":0,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0},"request_id":"fresh","duration_ms":1,"is_error":false}\n',
			),
		);
		nextEvents.push(...parser.finish());
		expect(nextEvents).toEqual([expect.objectContaining({ type: "result", result: "fresh", request_id: "fresh" })]);
	});
});
