import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createAntmlInvokeRecoveryStreamParser } from "../../src/tool-call-middleware/protocols/antml/recovery-stream.ts";
import type { StreamParserEvent } from "../../src/tool-call-middleware/types.ts";
import type { Tool } from "../../src/types.ts";

const bashTool = {
	name: "Bash",
	description: "Run a command",
	parameters: Type.Object({ command: Type.String({ minLength: 3 }) }),
} satisfies Tool;

function textOutput(events: readonly StreamParserEvent[]): string {
	return events
		.filter((event): event is Extract<StreamParserEvent, { type: "text" }> => event.type === "text")
		.map((event) => event.text)
		.join("");
}

function toolCallEvents(events: readonly StreamParserEvent[]): StreamParserEvent[] {
	return events.filter((event) => event.type.startsWith("toolcall_"));
}

describe("createAntmlInvokeRecoveryStreamParser", () => {
	it("emits start at the known invoke opening boundary", () => {
		// Given
		const parser = createAntmlInvokeRecoveryStreamParser([bashTool]);

		// When
		const openingEvents = parser.feed('<antml:invoke name="Bash">');

		// Then
		expect(openingEvents).toEqual([{ type: "toolcall_start", index: 0, name: "Bash", id: "recovered-antml-0" }]);

		// When
		const completionEvents = [
			...parser.feed('<antml:parameter name="command">echo recovered</antml:parameter></antml:invoke>'),
			...parser.finish(),
		];

		// Then
		expect(completionEvents).toEqual([
			{ type: "toolcall_delta", index: 0, argumentsDelta: '{"command":"echo recovered"}' },
			{
				type: "toolcall_end",
				index: 0,
				name: "Bash",
				id: "recovered-antml-0",
				arguments: { command: "echo recovered" },
			},
		]);
	});

	it("keeps unknown and ambiguous tools as text", () => {
		// Given
		const unknown = '<function_calls><invoke name="Missing"></invoke></function_calls>';
		const ambiguous = '<invoke name="bash"></invoke>';
		const unknownParser = createAntmlInvokeRecoveryStreamParser([bashTool]);
		const ambiguousParser = createAntmlInvokeRecoveryStreamParser([bashTool, { ...bashTool, name: "BASH" }]);

		// When
		const unknownEvents = [...unknownParser.feed(unknown), ...unknownParser.finish()];
		const ambiguousEvents = [...ambiguousParser.feed(ambiguous), ...ambiguousParser.finish()];

		// Then
		expect(textOutput(unknownEvents)).toBe(unknown);
		expect(textOutput(ambiguousEvents)).toBe(ambiguous);
		expect(toolCallEvents([...unknownEvents, ...ambiguousEvents])).toEqual([]);
	});

	it("finalizes schema failure after start as incomplete", () => {
		// Given
		const parser = createAntmlInvokeRecoveryStreamParser([bashTool]);

		// When
		const events = [
			...parser.feed('<invoke name="Bash">'),
			...parser.feed('<parameter name="command">42</parameter></invoke>'),
		];

		// Then
		expect(events).toEqual([
			{ type: "toolcall_start", index: 0, name: "Bash", id: "recovered-antml-0" },
			{ type: "toolcall_delta", index: 0, argumentsDelta: "{}" },
			{
				type: "toolcall_end",
				index: 0,
				name: "Bash",
				id: "recovered-antml-0",
				arguments: {},
				incomplete: true,
				errorMessage: "Recovered tool call arguments failed validation",
			},
		]);
	});

	it("never ends or makes a missing invoke close executable", () => {
		// Given
		const parser = createAntmlInvokeRecoveryStreamParser([bashTool]);

		// When
		const events = [
			...parser.feed('<invoke name="Bash"><parameter name="command">echo no-close</parameter>'),
			...parser.finish(),
		];

		// Then
		expect(events).toEqual([{ type: "toolcall_start", index: 0, name: "Bash", id: "recovered-antml-0" }]);
	});

	it("preserves nested prompt-like invokes inside an active parameter", () => {
		// Given
		const parser = createAntmlInvokeRecoveryStreamParser([bashTool]);

		// When
		const events = [
			...parser.feed(
				'<invoke name="Bash"><parameter name="command">echo <invoke name="X"></invoke></parameter></invoke>',
			),
			...parser.finish(),
		];

		// Then
		expect(events).toEqual([
			{ type: "toolcall_start", index: 0, name: "Bash", id: "recovered-antml-0" },
			{
				type: "toolcall_delta",
				index: 0,
				argumentsDelta: '{"command":"echo <invoke name=\\"X\\"></invoke>"}',
			},
			{
				type: "toolcall_end",
				index: 0,
				name: "Bash",
				id: "recovered-antml-0",
				arguments: { command: 'echo <invoke name="X"></invoke>' },
			},
		]);
	});

	it("consumes the wrapper close after a recovered call", () => {
		// Given
		const parser = createAntmlInvokeRecoveryStreamParser([bashTool]);

		// When
		const events = [
			...parser.feed(
				'<function_calls><invoke name="Bash"><parameter name="command">echo wrapped</parameter></invoke></function_calls>',
			),
			...parser.finish(),
		];

		// Then
		expect(textOutput(events)).toBe("");
		expect(toolCallEvents(events)).toEqual([
			{ type: "toolcall_start", index: 0, name: "Bash", id: "recovered-antml-0" },
			{ type: "toolcall_delta", index: 0, argumentsDelta: '{"command":"echo wrapped"}' },
			{
				type: "toolcall_end",
				index: 0,
				name: "Bash",
				id: "recovered-antml-0",
				arguments: { command: "echo wrapped" },
			},
		]);
	});
});
