import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createXtmlRecoveryStreamParser } from "../../src/tool-call-middleware/protocols/kimi-xtml/recovery-stream.ts";
import { recoverKimiXtmlThinking } from "../../src/tool-call-middleware/protocols/kimi-xtml/thinking-recovery.ts";
import type { StreamParserEvent } from "../../src/tool-call-middleware/types.ts";
import type { AssistantMessage, Tool } from "../../src/types.ts";

const todoTool: Tool = {
	name: "todo",
	description: "Track work items",
	parameters: Type.Object({ op: Type.String() }),
};

function textOf(events: readonly StreamParserEvent[]): string {
	return events
		.filter((event) => event.type === "text")
		.map((event) => (event.type === "text" ? event.text : ""))
		.join("");
}

function streamText(chunks: readonly string[]): string {
	const parser = createXtmlRecoveryStreamParser([todoTool]);
	const events: StreamParserEvent[] = [];
	for (const chunk of chunks) events.push(...parser.feed(chunk));
	events.push(...parser.finish());
	return textOf(events);
}

function messageWithText(text: string): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "apitopia",
		model: "kimi-k3-ultrafast-unlocked",
		content: [{ type: "text", text }],
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function visibleText(message: AssistantMessage): string {
	return message.content
		.filter((item) => item.type === "text")
		.map((item) => (item.type === "text" ? item.text : ""))
		.join("");
}

type MarkerShape = { readonly name: string; readonly marker: string; readonly trailing: string };

const MARKER_SHAPES: readonly MarkerShape[] = [
	{ name: "named close terminated by <|sep|>", marker: "<|close|>think", trailing: "<|sep|>" },
	{ name: "named close terminated by newline", marker: "<|close|>think", trailing: "\n" },
	{ name: "named close terminated by end of stream", marker: "<|close|>think", trailing: "\n" },
	{ name: "named open terminated by newline", marker: "<|open|>think", trailing: "\n" },
	{ name: "named close terminated by a space", marker: "<|close|>think", trailing: " " },
	{ name: "unnamed close", marker: "<|close|>", trailing: "<|sep|>" },
	{ name: "unnamed open", marker: "<|open|>", trailing: "<|sep|>" },
	{ name: "bare separator", marker: "<|sep|>", trailing: "" },
	{ name: "named response close terminated by newline", marker: "<|close|>response", trailing: "\n" },
];

const PRODUCTION_LEAK_TAIL = "Time to report, not act further.<|close|>think\n";

describe("kimi xtml channel markers never reach visible text", () => {
	it.each(MARKER_SHAPES)("strips a $name from the streamed text channel", ({ marker, trailing }: MarkerShape) => {
		// given
		const chunk = `before ${marker}${trailing}after`;

		// when
		const text = streamText([chunk]);

		// then
		expect(text).not.toContain("<|");
		expect(text).toContain("before ");
		expect(text).toContain("after");
	});

	it.each(MARKER_SHAPES)("strips a $name split across every chunk boundary", ({ marker, trailing }: MarkerShape) => {
		// given
		const payload = `${marker}${trailing}`;

		// when
		const outputs = Array.from({ length: payload.length - 1 }, (_unused, index) =>
			streamText([`before${payload.slice(0, index + 1)}`, `${payload.slice(index + 1)}after`]),
		);

		// then
		for (const output of outputs) expect(output).not.toContain("<|");
	});

	it.each(MARKER_SHAPES)("strips a $name from a visible text block", ({ marker, trailing }: MarkerShape) => {
		// given
		const message = messageWithText(`before ${marker}${trailing}after`);

		// when
		const recovered = recoverKimiXtmlThinking(message);

		// then
		expect(visibleText(recovered)).not.toContain("<|");
		expect(visibleText(recovered)).toContain("before ");
		expect(visibleText(recovered)).toContain("after");
	});

	it("strips the verbatim production leak from the streamed text channel", () => {
		// when
		const text = streamText([PRODUCTION_LEAK_TAIL]);

		// then
		expect(text).toBe("Time to report, not act further.\n");
	});

	it("strips the verbatim production leak from a visible text block", () => {
		// given
		const message = messageWithText(PRODUCTION_LEAK_TAIL);

		// when
		const recovered = recoverKimiXtmlThinking(message);

		// then
		expect(visibleText(recovered)).toBe("Time to report, not act further.\n");
	});

	it("keeps marker-shaped prose inside fenced code intact", () => {
		// given
		const literal = "Docs:\n```text\n<|close|>think\n<|open|>response\n```\ndone";

		// when
		const streamed = streamText([literal]);
		const recovered = recoverKimiXtmlThinking(messageWithText(literal));

		// then
		expect(streamed).toBe(literal);
		expect(visibleText(recovered)).toBe(literal);
	});

	it("keeps text that merely looks like a marker intact", () => {
		// given
		const prose = "compare a <| b and pipes |> here";

		// when
		const streamed = streamText([prose]);
		const recovered = recoverKimiXtmlThinking(messageWithText(prose));

		// then
		expect(streamed).toBe(prose);
		expect(visibleText(recovered)).toBe(prose);
	});

	it("strips a marker that ends the stream with no terminator", () => {
		// given / when
		const streamed = streamText(["before <|close|>think"]);
		const recovered = visibleText(recoverKimiXtmlThinking(messageWithText("before <|close|>think")));

		// then
		expect(streamed).toBe("before ");
		expect(recovered).toBe("before ");
	});

	it("absorbs a word run after a marker into the channel name", () => {
		// given
		const ambiguous = "before <|close|>thinkafter";

		// when
		const text = streamText([ambiguous]);

		// then
		expect(text).toBe("before ");
	});

	it("flushes an incomplete marker prefix that never completes before end of stream", () => {
		// when
		const text = streamText(["tail end <|clo"]);

		// then
		expect(text).toBe("tail end <|clo");
	});

	it("still recovers a well-formed tools block into tool call events", () => {
		// given
		const block = [
			"<|open|>tools<|sep|>",
			'<|open|>call tool="todo" index="1"<|sep|>',
			'<|open|>argument key="op" type="string"<|sep|>view<|close|>argument<|sep|>',
			"<|close|>call<|sep|>",
			"<|close|>tools<|sep|>",
		].join("");
		const parser = createXtmlRecoveryStreamParser([todoTool]);

		// when
		const events = [...parser.feed(`One moment. ${block} Done.`), ...parser.finish()];

		// then
		expect(events.find((event) => event.type === "toolcall_end")).toMatchObject({
			name: "todo",
			arguments: { op: "view" },
		});
		expect(textOf(events)).toBe("One moment.  Done.");
	});
});
