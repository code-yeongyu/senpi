import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createAntmlStreamParser } from "../../src/tool-call-middleware/protocols/antml/stream.ts";
import type { StreamParserEvent } from "../../src/tool-call-middleware/types.ts";
import type { Tool } from "../../src/types.ts";
import { FIXTURE_TOOLS, TRUNCATION_FIXTURES } from "./truncation-fixtures.ts";

const bashTool: Tool = {
	name: "Bash",
	description: "Run a shell command",
	parameters: Type.Object({ command: Type.String() }),
};

const editTool: Tool = {
	name: "Edit",
	description: "Edit a file",
	parameters: Type.Object({
		file_path: Type.String(),
		edits: Type.Array(Type.Object({ oldText: Type.String(), newText: Type.String() })),
	}),
};

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

describe("createAntmlStreamParser", () => {
	it("emits a complete invoke as one tool call with antml ids", () => {
		// given
		const parser = createAntmlStreamParser([bashTool]);

		// when
		const events = [
			...parser.feed('<invoke name="Bash"><parameter name="command">echo hi</parameter></invoke>'),
			...parser.finish(),
		];

		// then
		expect(events).toEqual([
			{ type: "toolcall_start", index: 0, name: "Bash", id: "antml-tool-0" },
			{ type: "toolcall_delta", index: 0, argumentsDelta: '{"command":"echo hi"}' },
			{ type: "toolcall_end", index: 0, name: "Bash", id: "antml-tool-0", arguments: { command: "echo hi" } },
		]);
	});

	it("drops the function_calls wrapper while preserving surrounding prose", () => {
		// given
		const parser = createAntmlStreamParser([bashTool]);
		const input =
			'Before <function_calls><invoke name="Bash"><parameter name="command">ls</parameter></invoke></function_calls> after';

		// when
		const events = [...parser.feed(input), ...parser.finish()];

		// then
		expect(toolCallEnds(events)).toHaveLength(1);
		expect(textOutput(events)).toBe("Before  after");
		expect(textOutput(events)).not.toContain("function_calls");
	});

	it("repairs sloppy nested arguments in the streaming path", () => {
		// given
		const parser = createAntmlStreamParser([editTool]);
		const input =
			'<invoke name="Edit">' +
			'<parameter name="path">f.py</parameter>' +
			'<parameter name="edits">[{"oldText":"a","newText":"b","requireUnique":true}]</parameter>' +
			"</invoke>";

		// when
		const events = [...parser.feed(input), ...parser.finish()];

		// then
		expect(toolCallEnds(events)).toEqual([
			expect.objectContaining({
				name: "Edit",
				arguments: { file_path: "f.py", edits: [{ oldText: "a", newText: "b" }] },
			}),
		]);
	});

	it("suppresses an unrecoverably malformed known invoke and reports it", () => {
		// given
		const onError = vi.fn();
		const countTool: Tool = {
			name: "Count",
			description: "Count",
			parameters: Type.Object({ count: Type.Number() }),
		};
		const parser = createAntmlStreamParser([countTool], { onError });
		const call = '<invoke name="Count"><parameter name="count">not-a-number</parameter></invoke>';

		// when
		const events = [...parser.feed(`Before ${call} after`), ...parser.finish()];

		// then
		expect(toolCallEnds(events)).toHaveLength(0);
		expect(textOutput(events)).toBe("Before  after");
		expect(onError).toHaveBeenCalledWith("Could not process streaming antml tool call, keeping original text.", {
			toolCall: call,
		});
	});

	it("flags an incomplete known invoke at finish", () => {
		// given
		const onError = vi.fn();
		const parser = createAntmlStreamParser([bashTool], { onError });

		// when
		const events = [...parser.feed('<invoke name="Bash"><parameter name="command">ls'), ...parser.finish()];

		// then
		expect(toolCallEnds(events)).toEqual([
			expect.objectContaining({
				incomplete: true,
				errorMessage: "Tool call was truncated mid-arguments",
			}),
		]);
		expect(onError).toHaveBeenCalledWith("antml tool call truncated at finish", {
			protocol: "antml",
			retainedLength: expect.any(Number),
		});
	});

	it.each(TRUNCATION_FIXTURES["anthropic-xml"])("handles truncation fixture: $title", (fixture) => {
		// given: invoke-level truncation semantics are shared with anthropic-xml
		const onError = vi.fn();
		const parser = createAntmlStreamParser(FIXTURE_TOOLS, {
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
				break;
			case "text":
				expect(ends).toEqual([]);
				expect(textOutput(events)).toContain(fixture.input);
				break;
		}
	});
});
