import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { anthropicXmlFormatToolCall } from "../../src/tool-call-middleware/protocols/anthropic-xml/format.ts";
import { createAnthropicXmlStreamParser } from "../../src/tool-call-middleware/protocols/anthropic-xml/stream.ts";
import type { StreamParserEvent } from "../../src/tool-call-middleware/types.ts";
import type { Tool } from "../../src/types.ts";

const bashTool = {
	name: "Bash",
	description: "Run a shell command",
	parameters: Type.Object({
		command: Type.String(),
	}),
} satisfies Tool;

const canonicalBashTool = {
	name: "bash",
	description: "Run a shell command",
	parameters: Type.Object({
		command: Type.String(),
	}),
} satisfies Tool;

const noopTool = {
	name: "noop",
	description: "Do nothing",
	parameters: Type.Object({}),
} satisfies Tool;

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

describe("createAnthropicXmlStreamParser edge cases", () => {
	it("round-trips encoded delimiters and boundary newlines from the formatter", () => {
		// given
		const command = "\nprintf '</parameter> </invoke> & <tag>'\n";
		const input = anthropicXmlFormatToolCall("Bash", { command });
		const parser = createAnthropicXmlStreamParser([bashTool]);

		// when
		const events = [...parser.feed(input), ...parser.finish()];

		// then
		expect(toolCallEnds(events).map((event) => event.arguments.command)).toEqual([command]);
		expect(textOutput(events)).toBe("");
	});

	it("canonicalizes a unique case-insensitive tool-name match to the declared stream tool name", () => {
		// given
		const parser = createAnthropicXmlStreamParser([canonicalBashTool]);

		// when
		const events = [
			...parser.feed('<invoke name="Bash"><parameter name="command">echo ulwqa</parameter></invoke>'),
			...parser.finish(),
		];

		// then
		expect(events).toEqual([
			{ type: "toolcall_start", index: 0, name: "bash", id: "anthropic-xml-tool-0" },
			{ type: "toolcall_delta", index: 0, argumentsDelta: '{"command":"echo ulwqa"}' },
			{
				type: "toolcall_end",
				index: 0,
				name: "bash",
				id: "anthropic-xml-tool-0",
				arguments: { command: "echo ulwqa" },
			},
		]);
	});

	it("preserves an unbalanced nested invoke opening tag inside a parameter value", () => {
		// given
		const command = 'prefix <invoke name="Other"> literally';
		const input = `<invoke name="Bash"><parameter name="command">${command}</parameter></invoke>`;

		// when
		const parser = createAnthropicXmlStreamParser([bashTool]);
		const events = [...parser.feed(input), ...parser.finish()];

		// then
		expect(toolCallEnds(events).map((event) => event.arguments.command)).toEqual([command]);
		expect(textOutput(events)).toBe("");
	});

	it("resynchronizes after an unclosed unknown invoke and streams a later known invoke", () => {
		// given
		const unknownPrefix = '<invoke name="Unknown"><parameter name="value">unterminated\n';
		const knownCall = '<invoke name="Bash"><parameter name="command">echo recovered</parameter></invoke>';
		const parser = createAnthropicXmlStreamParser([bashTool]);

		// when
		const events = [...parser.feed(unknownPrefix), ...parser.feed(knownCall), ...parser.finish()];

		// then
		expect(textOutput(events)).toBe(unknownPrefix);
		expect(toolCallEnds(events).map((event) => event.arguments.command)).toEqual(["echo recovered"]);
	});

	it("does not resynchronize away from an incomplete known invoke in the stream", () => {
		// given
		const onError = vi.fn();
		const input =
			'<invoke name="Bash"><parameter name="command">unterminated\n' +
			'<invoke name="Bash"><parameter name="command">echo hidden</parameter></invoke>';
		const parser = createAnthropicXmlStreamParser([bashTool], { onError });

		// when
		const events = [...parser.feed(input), ...parser.finish()];

		// then
		expect(toolCallEnds(events)).toEqual([]);
		expect(onError).toHaveBeenCalledWith("Could not complete streaming Anthropic XML tool call at finish.", {
			toolCall: input,
		});
	});

	it("does not stream a known no-parameter invoke closed by a later nested call", () => {
		// given
		const onError = vi.fn();
		const input = '<invoke name="noop">unterminated\n<invoke name="noop"></invoke>';
		const parser = createAnthropicXmlStreamParser([noopTool], { onError });

		// when
		const events = [...parser.feed(input), ...parser.finish()];

		// then
		expect(toolCallEnds(events)).toEqual([]);
		expect(onError).toHaveBeenCalledWith("Could not complete streaming Anthropic XML tool call at finish.", {
			toolCall: input,
		});
	});

	it("preserves literal function_calls prose when it does not wrap a recognized invoke", () => {
		// given
		const input = "Before <function_calls>literal prose</function_calls> after";
		const parser = createAnthropicXmlStreamParser([bashTool]);

		// when
		const events = [...parser.feed(input), ...parser.finish()];

		// then
		expect(textOutput(events)).toBe(input);
		expect(toolCallEnds(events)).toEqual([]);
	});

	it("preserves a function_calls wrapper when its recognized invoke is incomplete", () => {
		// given
		const onError = vi.fn();
		const input = 'Before <function_calls><invoke name="Bash">literal</function_calls> after';
		const parser = createAnthropicXmlStreamParser([bashTool], { onError });

		// when
		const events = [...parser.feed(input), ...parser.finish()];

		// then
		expect(textOutput(events)).toBe(input);
		expect(toolCallEnds(events)).toEqual([]);
		expect(onError).not.toHaveBeenCalled();
	});

	it.each([
		{ emitRaw: false, expected: [] },
		{ emitRaw: true, expected: [{ type: "text", text: '<invoke name="Bash' }] },
	])("applies the error policy to a recognized opening tag truncated before the closing quote (raw: $emitRaw)", ({
		emitRaw,
		expected,
	}) => {
		// given
		const onError = vi.fn();
		const parser = createAnthropicXmlStreamParser([bashTool], {
			emitRawToolCallTextOnError: emitRaw,
			onError,
		});
		const incompleteCall = '<invoke name="Bash';

		// when
		const feedEvents = parser.feed(`Before ${incompleteCall}`);
		const finishEvents = parser.finish();

		// then
		expect(feedEvents).toEqual([{ type: "text", text: "Before " }]);
		expect(finishEvents).toEqual(expected);
		expect(onError).toHaveBeenCalledOnce();
		expect(onError).toHaveBeenCalledWith("Could not complete streaming Anthropic XML tool call at finish.", {
			toolCall: incompleteCall,
		});
	});
});
