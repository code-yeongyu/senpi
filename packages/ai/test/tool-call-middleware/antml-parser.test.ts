import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { parseAntmlGeneratedText } from "../../src/tool-call-middleware/protocols/antml/parse.ts";
import type { Tool } from "../../src/types.ts";

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

describe("parseAntmlGeneratedText", () => {
	it("parses a function_calls-wrapped invoke", () => {
		// given
		const text =
			'<function_calls><invoke name="Bash"><parameter name="command">echo hi</parameter></invoke></function_calls>';

		// when
		const parsed = parseAntmlGeneratedText(text, [bashTool]);

		// then
		expect(parsed).toEqual([{ name: "Bash", arguments: { command: "echo hi" } }]);
	});

	it("parses multiple invokes inside one function_calls block", () => {
		// given
		const text =
			"<function_calls>\n" +
			'<invoke name="Bash"><parameter name="command">one</parameter></invoke>\n' +
			'<invoke name="Bash"><parameter name="command">two</parameter></invoke>\n' +
			"</function_calls>";

		// when
		const parsed = parseAntmlGeneratedText(text, [bashTool]);

		// then
		expect(parsed.map((call) => call.arguments.command)).toEqual(["one", "two"]);
	});

	it("parses a bare invoke without the wrapper", () => {
		// given
		const text = '<invoke name="Bash"><parameter name="command">ls</parameter></invoke>';

		// when
		const parsed = parseAntmlGeneratedText(text, [bashTool]);

		// then
		expect(parsed).toEqual([{ name: "Bash", arguments: { command: "ls" } }]);
	});

	it("repairs the Pi edits[] regression instead of rejecting the call", () => {
		// given: byte-correct edit plus invented trailing keys
		const text =
			'<invoke name="Edit">' +
			'<parameter name="file_path">some/file.py</parameter>' +
			'<parameter name="edits">[{"oldText":"a","newText":"b","requireUnique":true}]</parameter>' +
			'<parameter name="notes">extra</parameter>' +
			"</invoke>";

		// when
		const parsed = parseAntmlGeneratedText(text, [editTool]);

		// then
		expect(parsed).toEqual([
			{
				name: "Edit",
				arguments: { file_path: "some/file.py", edits: [{ oldText: "a", newText: "b" }] },
			},
		]);
	});

	it("keeps unknown-tool invokes out of the parse result", () => {
		// given
		const text = '<invoke name="Missing"><parameter name="command">x</parameter></invoke>';

		// when / then
		expect(parseAntmlGeneratedText(text, [bashTool])).toEqual([]);
	});

	it("reports unrecoverably malformed calls through onError", () => {
		// given
		const onError = vi.fn();
		const text = '<invoke name="Bash"><parameter name="command"></parameter></invoke>';
		const strictTool: Tool = {
			...bashTool,
			parameters: Type.Object({ command: Type.String({ minLength: 1 }) }),
		};

		// when
		const parsed = parseAntmlGeneratedText(text, [strictTool], { onError });

		// then
		expect(parsed).toEqual([]);
		expect(onError).toHaveBeenCalledWith("Could not process antml tool call, keeping original text.", {
			toolCall: text,
		});
	});
});
