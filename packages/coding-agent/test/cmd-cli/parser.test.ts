import { describe, expect, it } from "vitest";
import { buildCmdCliArgs } from "../../src/core/extensions/builtin/cmd-cli/spawn-args.ts";
import {
	type CmdCliStreamEvent,
	CmdCliStreamParser,
	type CmdCliUsage,
} from "../../src/core/extensions/builtin/cmd-cli/stream-parser.ts";

const encoder = new TextEncoder();

// Minimal 4-line NDJSON literal covering: unknown event, text_delta, malformed JSON, result
const FIXTURE_4_LINE_NDJSON = `{"type":"event","event":{"type":"unknown_event","data":"ignored"}}
{"type":"event","event":{"type":"text_delta","delta":"Hello world!"}}
{"invalid_json
{"type":"result","subtype":"success","usage":{"inputTokens":12,"outputTokens":4,"cacheReadTokens":2,"cacheWriteTokens":1},"stopReason":"stop","finalText":"Hello world!","message":"Hello world!"}
`;

function parseChunks(chunks: readonly Uint8Array[]) {
	const parser = new CmdCliStreamParser();
	const events: CmdCliStreamEvent[] = chunks.flatMap((chunk) => parser.push(chunk));
	events.push(...parser.finish());
	return { parser, events, diagnostics: parser.diagnostics, unknownEventCount: parser.unknownEventCount };
}

describe("buildCmdCliArgs", () => {
	it("builds baseline invocation with only prompt in byte-exact order", () => {
		const args = buildCmdCliArgs({});
		expect(args).toEqual(["-p", "--output-format", "json"]);
	});

	it("adds all optional flags in exact specified order", () => {
		const opts = { model: "cmd-large", effort: "high", maxTurns: 10, permissionMode: "ask" };
		expect(buildCmdCliArgs(opts)).toEqual([
			"-p",
			"--output-format",
			"json",
			"-m",
			"cmd-large",
			"--effort",
			"high",
			"--max-turns",
			"10",
			"--permission-mode",
			"ask",
		]);
	});

	it("supports maxTurns: 0 without omitting the flag", () => {
		const args = buildCmdCliArgs({ maxTurns: 0 });
		expect(args).toEqual(["-p", "--output-format", "json", "--max-turns", "0"]);
	});

	it("includes individual optional flags independently", () => {
		const base = ["-p", "--output-format", "json"];
		expect(buildCmdCliArgs({ model: "m" })).toEqual([...base, "-m", "m"]);
		expect(buildCmdCliArgs({ effort: "low" })).toEqual([...base, "--effort", "low"]);
		expect(buildCmdCliArgs({ maxTurns: 5 })).toEqual([...base, "--max-turns", "5"]);
		expect(buildCmdCliArgs({ permissionMode: "allow" })).toEqual([...base, "--permission-mode", "allow"]);
	});

	it("omits empty string optional flags", () => {
		const args = buildCmdCliArgs({ model: "", effort: "", permissionMode: "" });
		expect(args).toEqual(["-p", "--output-format", "json"]);
	});
});

describe("CmdCliStreamParser", () => {
	it("parses 4-line NDJSON literal and accumulates text deltas", () => {
		const bytes = encoder.encode(FIXTURE_4_LINE_NDJSON);
		const { parser, events, unknownEventCount } = parseChunks([bytes]);

		expect(parser.accumulatedText).toBe("Hello world!");
		expect(unknownEventCount).toBe(1);
		expect(events).toHaveLength(3);
		expect(events[0]).toEqual({ type: "event", event: { type: "text_delta", delta: "Hello world!" } });
		expect(events[1]).toEqual(expect.objectContaining({ type: "malformed_stream", reason: "invalid_json" }));
		expect(events[2]?.type).toBe("result");
		if (events[2]?.type === "result") {
			expect(events[2].message).toBe("Hello world!");
			expect(events[2].usage).toEqual({ inputTokens: 12, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 });
		}
	});

	it("parses a line split across arbitrary chunk boundaries identically", () => {
		const rawBytes = encoder.encode(FIXTURE_4_LINE_NDJSON);
		const singleBytes = Array.from(rawBytes, (_, i) => rawBytes.subarray(i, i + 1));
		const midChunks: Uint8Array[] = [];
		for (let i = 0; i < rawBytes.length; i += 17) midChunks.push(rawBytes.subarray(i, i + 17));

		const parsedWhole = parseChunks([rawBytes]);
		for (const parsed of [parseChunks(singleBytes), parseChunks(midChunks)]) {
			expect(parsed.events).toEqual(parsedWhole.events);
			expect(parsed.parser.accumulatedText).toBe(parsedWhole.parser.accumulatedText);
			expect(parsed.unknownEventCount).toBe(parsedWhole.unknownEventCount);
		}
	});

	it("ignores unknown event types without throwing and increments unknownEventCount", () => {
		const input =
			[
				'{"type":"event","event":{"type":"unknown_one"}}',
				'{"type":"random_top_level_event","data":123}',
				'{"type":"event","event":{"type":"text_delta","delta":"text"}}',
			].join("\n") + "\n";

		const { events, unknownEventCount } = parseChunks([encoder.encode(input)]);
		expect(unknownEventCount).toBe(2);
		expect(events).toEqual([{ type: "event", event: { type: "text_delta", delta: "text" } }]);
	});

	it("properly parses and exposes result line message and usage passthrough", () => {
		const customUsage: CmdCliUsage = {
			inputTokens: 5000,
			outputTokens: 800,
			cacheReadTokens: 1200,
			cacheWriteTokens: 300,
		};
		const resultLine = `${JSON.stringify({
			type: "result",
			subtype: "success",
			sessionId: "sess-xyz",
			stopReason: "stop",
			usage: customUsage,
			durationMs: 4200,
			finalText: "Final completion message",
			message: "Final completion message",
		})}\n`;

		const { events } = parseChunks([encoder.encode(resultLine)]);
		expect(events).toHaveLength(1);
		const resultEvent = events[0];
		expect(resultEvent?.type).toBe("result");
		if (resultEvent && resultEvent.type === "result") {
			expect(resultEvent.subtype).toBe("success");
			expect(resultEvent.sessionId).toBe("sess-xyz");
			expect(resultEvent.stopReason).toBe("stop");
			expect(resultEvent.durationMs).toBe(4200);
			expect(resultEvent.finalText).toBe("Final completion message");
			expect(resultEvent.message).toBe("Final completion message");
			expect(resultEvent.usage).toEqual(customUsage);
		}
	});

	it("yields typed error malformed_stream for non-JSON lines and records diagnostics", () => {
		const { events, diagnostics } = parseChunks([encoder.encode("non-json garbage\n")]);
		expect(events).toEqual([expect.objectContaining({ type: "malformed_stream", reason: "invalid_json" })]);
		expect(diagnostics).toContain("non-json garbage");
	});

	it("yields typed error malformed_stream for truncated JSON on finish()", () => {
		const parser = new CmdCliStreamParser();
		parser.push(encoder.encode('{"type":"event","event":{"type":'));
		expect(parser.finish()).toEqual([
			expect.objectContaining({ type: "malformed_stream", reason: "truncated_tail" }),
		]);
	});

	it("yields typed error malformed_stream for non-object JSON", () => {
		const parser = new CmdCliStreamParser();
		expect(parser.push(encoder.encode('"just a string"\n'))).toEqual([
			expect.objectContaining({ type: "malformed_stream", reason: "invalid_event" }),
		]);
	});

	it("resets accumulatedText, buffer, diagnostics, and counters on reset()", () => {
		const parser = new CmdCliStreamParser();
		parser.push(encoder.encode('{"type":"event","event":{"type":"text_delta","delta":"part 1"}}\n{"bad_json\n'));
		expect(parser.accumulatedText).toBe("part 1");
		expect(parser.diagnostics).toHaveLength(1);
		parser.reset();
		expect(parser.accumulatedText).toBe("");
		expect(parser.unknownEventCount).toBe(0);
		expect(parser.diagnostics).toHaveLength(0);
	});

	it("ignores top-level text_delta events because only event-wrapped text_delta is supported", () => {
		const { events, unknownEventCount } = parseChunks([encoder.encode('{"type":"text_delta","delta":"ignored"}\n')]);
		expect(unknownEventCount).toBe(1);
		expect(events).toHaveLength(0);
	});

	it("passes through result line with missing subtype without default", () => {
		const { events } = parseChunks([encoder.encode('{"type":"result","message":"done"}\n')]);
		expect(events).toHaveLength(1);
		const resultEvent = events[0];
		expect(resultEvent?.type).toBe("result");
		if (resultEvent && resultEvent.type === "result") {
			expect(resultEvent.subtype).toBeUndefined();
			expect(resultEvent.message).toBe("done");
			expect(resultEvent.finalText).toBe("done");
			expect(resultEvent.usage).toBeUndefined();
		}
	});
});
