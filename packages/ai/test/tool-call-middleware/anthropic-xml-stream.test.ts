import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createAnthropicXmlStreamParser } from "../../src/tool-call-middleware/protocols/anthropic-xml/stream.ts";
import type { ParserOptions, StreamParserEvent } from "../../src/tool-call-middleware/types.ts";
import type { Tool } from "../../src/types.ts";
import { FIXTURE_TOOLS, TRUNCATION_FIXTURES } from "./truncation-fixtures.ts";

const bashTool = {
	name: "Bash",
	description: "Run a shell command",
	parameters: Type.Object({
		command: Type.String(),
	}),
} satisfies Tool;

const counterTool = {
	name: "Count",
	description: "Count a value",
	parameters: Type.Object({
		count: Type.Number(),
	}),
} satisfies Tool;

const noopTool = {
	name: "noop",
	description: "Do nothing",
	parameters: Type.Object({}),
} satisfies Tool;

function seededRandom(seed: number): () => number {
	let current = seed;
	return () => {
		current = (current * 9301 + 49_297) % 233_280;
		return current / 233_280;
	};
}

function randomChunkSplit(text: string, seed: number): string[] {
	const random = seededRandom(seed);
	const chunks: string[] = [];
	let index = 0;
	while (index < text.length) {
		const size = Math.floor(random() * 8) + 1;
		chunks.push(text.slice(index, index + size));
		index += size;
	}
	return chunks;
}

function collectBashEvents(input: string, seed: number, options?: ParserOptions): StreamParserEvent[] {
	const parser = createAnthropicXmlStreamParser([bashTool], options);
	const events: StreamParserEvent[] = [];
	for (const chunk of randomChunkSplit(input, seed)) {
		events.push(...parser.feed(chunk));
	}
	events.push(...parser.finish());
	return events;
}

function textOutput(events: StreamParserEvent[]): string {
	return events
		.filter((event): event is Extract<StreamParserEvent, { type: "text" }> => event.type === "text")
		.map((event) => event.text)
		.join("");
}

function toolCallEnds(events: StreamParserEvent[]): Extract<StreamParserEvent, { type: "toolcall_end" }>[] {
	return events.filter(
		(event): event is Extract<StreamParserEvent, { type: "toolcall_end" }> => event.type === "toolcall_end",
	);
}

describe("createAnthropicXmlStreamParser", () => {
	it("emits a complete invoke as one tool call", () => {
		// given
		const parser = createAnthropicXmlStreamParser([bashTool]);

		// when
		const events = [
			...parser.feed('<invoke name="Bash"><parameter name="command">echo hi</parameter></invoke>'),
			...parser.finish(),
		];

		// then
		expect(events).toEqual([
			{ type: "toolcall_start", index: 0, name: "Bash", id: "anthropic-xml-tool-0" },
			{ type: "toolcall_delta", index: 0, argumentsDelta: '{"command":"echo hi"}' },
			{
				type: "toolcall_end",
				index: 0,
				name: "Bash",
				id: "anthropic-xml-tool-0",
				arguments: { command: "echo hi" },
			},
		]);
	});

	it.each([0, 1, 7, 13, 21, 42])("keeps arbitrary chunk splits stable (seed %s)", (seed) => {
		// given
		const input =
			'Before <invoke name="Bash"><parameter name="command">printf \'<ok>\'\nnext</parameter></invoke> after';

		// when
		const events = collectBashEvents(input, seed);

		// then
		expect(toolCallEnds(events)).toEqual([
			{
				type: "toolcall_end",
				index: 0,
				name: "Bash",
				id: "anthropic-xml-tool-0",
				arguments: { command: "printf '<ok>'\nnext" },
			},
		]);
		expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "toolcall_delta")).toEqual([
			{ type: "toolcall_delta", index: 0, argumentsDelta: '{"command":"printf \'<ok>\'\\nnext"}' },
		]);
		expect(textOutput(events)).toBe("Before  after");
		expect(textOutput(events)).not.toContain("<invoke");
		expect(textOutput(events)).not.toContain("</invoke>");
	});

	it("withholds a split invoke start tag from plain text", () => {
		// given
		const parser = createAnthropicXmlStreamParser([bashTool]);

		// when
		const firstEvents = parser.feed("prefix <inv");
		const remainingEvents = [
			...parser.feed('oke name="Bash"><parameter name="command">ls</parameter></invoke> suffix'),
			...parser.finish(),
		];

		// then
		expect(firstEvents).toEqual([{ type: "text", text: "prefix " }]);
		expect(firstEvents.some((event) => event.type === "toolcall_end")).toBe(false);
		expect(toolCallEnds(remainingEvents)).toHaveLength(1);
		expect(textOutput([...firstEvents, ...remainingEvents])).toBe("prefix  suffix");
	});

	it("drops the optional function_calls wrapper while preserving prose", () => {
		// given
		const input =
			'Before <function_calls><invoke name="Bash"><parameter name="command">ls</parameter></invoke></function_calls> after';

		// when
		const events = collectBashEvents(input, 13);

		// then
		expect(toolCallEnds(events)).toHaveLength(1);
		expect(textOutput(events)).toBe("Before  after");
		expect(textOutput(events)).not.toContain("function_calls");
	});

	it("assigns deterministic ids to consecutive known invokes", () => {
		// given
		const parser = createAnthropicXmlStreamParser([bashTool]);
		const input =
			'<invoke name="Bash"><parameter name="command">one</parameter></invoke><invoke name="Bash"><parameter name="command">two</parameter></invoke>';

		// when
		const events = [...parser.feed(input), ...parser.finish()];

		// then
		expect(
			toolCallEnds(events).map((event) => ({ index: event.index, id: event.id, command: event.arguments.command })),
		).toEqual([
			{ index: 0, id: "anthropic-xml-tool-0", command: "one" },
			{ index: 1, id: "anthropic-xml-tool-1", command: "two" },
		]);
	});

	it("preserves prompt-like invoke markup inside a parameter value", () => {
		// given
		const command = 'Show <invoke name="Other"><parameter name="example">raw</parameter></invoke> exactly as text';
		const input = `<invoke name="Bash"><parameter name="command">${command}</parameter></invoke>`;

		// when
		const events = collectBashEvents(input, 21);

		// then
		expect(toolCallEnds(events).map((event) => event.arguments.command)).toEqual([command]);
		expect(textOutput(events)).toBe("");
	});

	it("keeps a complete unknown invoke as text without reporting an error", () => {
		// given
		const onError = vi.fn();
		const parser = createAnthropicXmlStreamParser([bashTool], { onError });
		const unknownCall = '<invoke name="Other"><parameter name="command">echo no</parameter></invoke>';

		// when
		const events = [...parser.feed(`Before ${unknownCall} after`), ...parser.finish()];

		// then
		expect(toolCallEnds(events)).toHaveLength(0);
		expect(textOutput(events)).toBe(`Before ${unknownCall} after`);
		expect(onError).not.toHaveBeenCalled();
	});

	it("suppresses a malformed known invoke and reports the original text", () => {
		// given
		const onError = vi.fn();
		const parser = createAnthropicXmlStreamParser([counterTool], { onError });
		const call = '<invoke name="Count"><parameter name="count">not-a-number</parameter></invoke>';

		// when
		const events = [...parser.feed(`Before ${call} after`), ...parser.finish()];

		// then
		expect(events).toEqual([
			{ type: "text", text: "Before " },
			{ type: "text", text: " after" },
		]);
		expect(onError).toHaveBeenCalledWith(
			"Could not process streaming Anthropic XML tool call, keeping original text.",
			{
				toolCall: call,
			},
		);
	});

	it("emits a malformed complete invoke as raw text when enabled", () => {
		// given
		const onError = vi.fn();
		const parser = createAnthropicXmlStreamParser([counterTool], {
			onError,
			emitRawToolCallTextOnError: true,
		});
		const call = '<invoke name="Count"><parameter name="count">not-a-number</parameter></invoke>';

		// when
		const events = [...parser.feed(`Before ${call} after`), ...parser.finish()];

		// then
		expect(textOutput(events)).toBe(`Before ${call} after`);
		expect(toolCallEnds(events)).toHaveLength(0);
		expect(onError).toHaveBeenCalledOnce();
	});

	it("rejects malformed parameter markup for a no-parameter tool", () => {
		// given
		const onError = vi.fn();
		const parser = createAnthropicXmlStreamParser([noopTool], { onError });
		const call = '<invoke name="noop"><parameter name="ignored">unterminated</invoke>';

		// when
		const events = [...parser.feed(`Before ${call} after`), ...parser.finish()];

		// then
		expect(toolCallEnds(events)).toHaveLength(0);
		expect(textOutput(events)).toBe("Before  after");
		expect(onError).toHaveBeenCalledWith(
			"Could not process streaming Anthropic XML tool call, keeping original text.",
			{ toolCall: call },
		);
	});

	it("flags an incomplete known invoke at finish without raw text", () => {
		// given
		const onError = vi.fn();
		const parser = createAnthropicXmlStreamParser([bashTool], {
			onError,
			emitRawToolCallTextOnError: true,
		});
		const incompleteCall = '<invoke name="Bash"><parameter name="command">ls';

		// when
		const events = [...parser.feed(`Before ${incompleteCall}`), ...parser.finish()];

		// then
		expect(textOutput(events)).toBe("Before ");
		expect(toolCallEnds(events)).toEqual([
			expect.objectContaining({
				incomplete: true,
				arguments: {},
				errorMessage: "Tool call was truncated mid-arguments",
			}),
		]);
		expect(JSON.stringify(onError.mock.calls)).not.toContain(incompleteCall);
	});

	it("flags a recognized opening tag truncated before its closing quote without raw text", () => {
		// given
		const onError = vi.fn();
		const parser = createAnthropicXmlStreamParser([bashTool], {
			emitRawToolCallTextOnError: true,
			onError,
		});
		const incompleteCall = '<invoke name="Bash"';

		// when
		const events = [...parser.feed(`Before ${incompleteCall}`), ...parser.finish()];

		// then
		expect(textOutput(events)).toBe("Before ");
		expect(toolCallEnds(events)).toEqual([
			expect.objectContaining({
				incomplete: true,
				arguments: {},
				errorMessage: "Tool call was truncated mid-arguments",
			}),
		]);
		expect(JSON.stringify(onError.mock.calls)).not.toContain(incompleteCall);
	});

	it.each(TRUNCATION_FIXTURES["anthropic-xml"])("handles truncation fixture: $title", (fixture) => {
		// given
		const onError = vi.fn();
		const parser = createAnthropicXmlStreamParser(FIXTURE_TOOLS, {
			emitRawToolCallTextOnError: true,
			onError,
		});

		// when
		const events = [...parser.feed(fixture.input), ...parser.finish()];
		const ends = toolCallEnds(events);

		// then
		switch (fixture.expected.kind) {
			case "recovered":
				expect(ends).toEqual([
					expect.objectContaining({ name: fixture.tool, arguments: fixture.expected.arguments }),
				]);
				expect(ends[0]?.incomplete).toBeUndefined();
				break;
			case "incomplete":
				expect(ends).toEqual([expect.objectContaining({ name: fixture.tool, incomplete: true })]);
				expect(textOutput(events)).not.toContain("<invoke");
				expect(JSON.stringify(onError.mock.calls)).not.toContain(fixture.input);
				break;
			case "dropped":
				expect(ends).toEqual([]);
				expect(events.filter((event) => event.type.startsWith("toolcall_"))).toEqual([]);
				expect(textOutput(events)).not.toContain(fixture.input);
				expect(onError).toHaveBeenCalledOnce();
				expect(JSON.stringify(onError.mock.calls)).not.toContain(fixture.input);
				break;
			case "text":
				expect(ends).toEqual([]);
				expect(textOutput(events)).toContain(fixture.input);
				break;
		}
	});

	it("recovers a complete invoke in a truncated function_calls wrapper without emitting wrapper markup", () => {
		const parser = createAnthropicXmlStreamParser(FIXTURE_TOOLS);
		const events = [
			...parser.feed('<function_calls><invoke name="get_weather"><parameter name="city">Seoul</parameter></invoke>'),
			...parser.finish(),
		];

		expect(toolCallEnds(events)).toEqual([
			expect.objectContaining({ name: "get_weather", arguments: { city: "Seoul" } }),
		]);
		expect(toolCallEnds(events)[0]?.incomplete).toBeUndefined();
		expect(textOutput(events)).not.toContain("<function_calls>");
		expect(textOutput(events)).not.toContain("<invoke");
	});

	it("recovers and flags invokes in a truncated function_calls wrapper in source order", () => {
		const parser = createAnthropicXmlStreamParser(FIXTURE_TOOLS);
		const events = [
			...parser.feed(
				'<function_calls><invoke name="get_weather"><parameter name="city">Seoul</parameter></invoke><invoke name="get_weather"><parameter name="city">Seo',
			),
			...parser.finish(),
		];

		expect(toolCallEnds(events)).toEqual([
			expect.objectContaining({ name: "get_weather", arguments: { city: "Seoul" } }),
			expect.objectContaining({ name: "get_weather", incomplete: true }),
		]);
		expect(textOutput(events)).not.toContain("<function_calls>");
		expect(textOutput(events)).not.toContain("<invoke");
	});
});
