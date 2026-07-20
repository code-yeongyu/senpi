import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { anthropicXmlFormatToolCall } from "../../src/tool-call-middleware/protocols/anthropic-xml/format.ts";
import { parseAnthropicXmlGeneratedText } from "../../src/tool-call-middleware/protocols/anthropic-xml/parse.ts";
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

const inspectTool = {
	name: "inspect",
	description: "Inspect a value",
	parameters: Type.Object({
		label: Type.String(),
		count: Type.Number(),
	}),
} satisfies Tool;

const flagTool = {
	name: "Flag",
	description: "Toggle a flag",
	parameters: Type.Object({ enabled: Type.Boolean() }),
} satisfies Tool;

const noopTool = {
	name: "noop",
	description: "Do nothing",
	parameters: Type.Object({}),
} satisfies Tool;

const optionalTool = {
	name: "optional",
	description: "Accept an optional note",
	parameters: Type.Object({
		note: Type.Optional(Type.String()),
	}),
} satisfies Tool;

const xmlSensitiveTool = {
	name: 'probe<&"',
	description: "Probe XML-sensitive values",
	parameters: Type.Object({ message: Type.String() }),
} satisfies Tool;

describe("parseAnthropicXmlGeneratedText", () => {
	it("parses one bare invoke with schema-typed parameters", () => {
		// given
		const text =
			'<invoke name="inspect"><parameter name="label">sample</parameter><parameter name="count">3.5</parameter></invoke>';

		// when
		const parsed = parseAnthropicXmlGeneratedText(text, [inspectTool]);

		// then
		expect(parsed).toEqual([{ name: "inspect", arguments: { label: "sample", count: 3.5 } }]);
	});

	it("parses a pretty-printed Boolean parameter", () => {
		// given
		const text = '<invoke name="Flag"><parameter name="enabled">\ntrue\n</parameter></invoke>';

		// when
		const parsed = parseAnthropicXmlGeneratedText(text, [flagTool]);

		// then
		expect(parsed).toEqual([{ name: "Flag", arguments: { enabled: true } }]);
	});

	it("parses multiple invokes in order", () => {
		// given
		const text = [
			"before",
			'<invoke name="Bash"><parameter name="command">echo first</parameter></invoke>',
			"between",
			'<invoke name="Bash"><parameter name="command">echo second</parameter></invoke>',
			"after",
		].join(" ");

		// when
		const parsed = parseAnthropicXmlGeneratedText(text, [bashTool]);

		// then
		expect(parsed).toEqual([
			{ name: "Bash", arguments: { command: "echo first" } },
			{ name: "Bash", arguments: { command: "echo second" } },
		]);
	});

	it("canonicalizes a unique case-insensitive tool-name match to the declared tool name", () => {
		// given
		const text = '<invoke name="Bash"><parameter name="command">echo ulwqa</parameter></invoke>';

		// when
		const parsed = parseAnthropicXmlGeneratedText(text, [canonicalBashTool]);

		// then
		expect(parsed).toEqual([{ name: "bash", arguments: { command: "echo ulwqa" } }]);
	});

	it("does not guess an ambiguous case-insensitive tool-name match", () => {
		// given
		const text = '<invoke name="BaSh"><parameter name="command">echo ulwqa</parameter></invoke>';

		// when
		const parsed = parseAnthropicXmlGeneratedText(text, [canonicalBashTool, bashTool]);

		// then
		expect(parsed).toEqual([]);
	});

	it("accepts an optional function_calls wrapper", () => {
		// given
		const text = '<function_calls>\n<invoke name="noop"></invoke>\n</function_calls>';

		// when
		const parsed = parseAnthropicXmlGeneratedText(text, [noopTool]);

		// then
		expect(parsed).toEqual([{ name: "noop", arguments: {} }]);
	});

	it("preserves embedded angle brackets and multiline string values", () => {
		// given
		const command = "printf '<value> & keep'\nline two";
		const text = `<invoke name="Bash"><parameter name="command">${command}</parameter></invoke>`;

		// when
		const parsed = parseAnthropicXmlGeneratedText(text, [bashTool]);

		// then
		expect(parsed).toEqual([{ name: "Bash", arguments: { command } }]);
	});

	it("round-trips XML delimiters and boundary newlines from the formatter", () => {
		// given
		const message = "\n\nalpha &#10; </parameter> beta </invoke> & <tag>\r\nmiddle\n\n";
		const text = anthropicXmlFormatToolCall(xmlSensitiveTool.name, { message });

		// when
		const parsed = parseAnthropicXmlGeneratedText(text, [xmlSensitiveTool]);

		// then
		expect(text).toContain('<parameter name="message">&#10;&#10;alpha');
		expect(text).toContain("middle&#10;&#10;</parameter>");
		expect(parsed).toEqual([{ name: xmlSensitiveTool.name, arguments: { message } }]);
	});

	it("preserves prompt-like invoke markup inside a parameter value", () => {
		// given
		const command = 'Show <invoke name="Other"><parameter name="example">raw</parameter></invoke> exactly as text';
		const text = `<invoke name="Bash"><parameter name="command">${command}</parameter></invoke>`;

		// when
		const parsed = parseAnthropicXmlGeneratedText(text, [bashTool]);

		// then
		expect(parsed).toEqual([{ name: "Bash", arguments: { command } }]);
	});

	it("preserves an unbalanced nested invoke opening tag inside a parameter value", () => {
		// given
		const command = 'prefix <invoke name="Other"> literally';
		const text = `<invoke name="Bash"><parameter name="command">${command}</parameter></invoke>`;

		// when
		const parsed = parseAnthropicXmlGeneratedText(text, [bashTool]);

		// then
		expect(parsed).toEqual([{ name: "Bash", arguments: { command } }]);
	});

	it("skips unknown invokes and continues with later known invokes", () => {
		// given
		const text = [
			'<invoke name="Unknown"><parameter name="value">ignored</parameter></invoke>',
			'<invoke name="Bash"><parameter name="command">echo known</parameter></invoke>',
		].join("\n");

		// when
		const parsed = parseAnthropicXmlGeneratedText(text, [bashTool]);

		// then
		expect(parsed).toEqual([{ name: "Bash", arguments: { command: "echo known" } }]);
	});

	it("resynchronizes after an unclosed unknown invoke and parses a later known invoke", () => {
		// given
		const text =
			'<invoke name="Unknown"><parameter name="value">unterminated\n' +
			'<invoke name="Bash"><parameter name="command">echo recovered</parameter></invoke>';

		// when
		const parsed = parseAnthropicXmlGeneratedText(text, [bashTool]);

		// then
		expect(parsed).toEqual([{ name: "Bash", arguments: { command: "echo recovered" } }]);
	});

	it("does not resynchronize away from an incomplete known invoke", () => {
		// given
		const text =
			'<invoke name="Bash"><parameter name="command">unterminated\n' +
			'<invoke name="Bash"><parameter name="command">echo hidden</parameter></invoke>';

		// when
		const parsed = parseAnthropicXmlGeneratedText(text, [bashTool]);

		// then
		expect(parsed).toEqual([]);
	});

	it("does not complete a known no-parameter invoke with a later nested close tag", () => {
		// given
		const text = '<invoke name="noop">unterminated\n<invoke name="noop"></invoke>';

		// when
		const parsed = parseAnthropicXmlGeneratedText(text, [noopTool]);

		// then
		expect(parsed).toEqual([]);
	});

	it("reports invalid coercion and skips the malformed call", () => {
		// given
		const onError = vi.fn();
		const text = [
			'<invoke name="inspect"><parameter name="label">bad</parameter><parameter name="count">not-a-number</parameter></invoke>',
			'<invoke name="inspect"><parameter name="label">good</parameter><parameter name="count">2</parameter></invoke>',
		].join("\n");

		// when
		const parsed = parseAnthropicXmlGeneratedText(text, [inspectTool], { onError });

		// then
		expect(parsed).toEqual([{ name: "inspect", arguments: { label: "good", count: 2 } }]);
		expect(onError).toHaveBeenCalledOnce();
		expect(onError).toHaveBeenCalledWith(
			"Could not process anthropic-xml tool call, keeping original text.",
			expect.objectContaining({
				toolCall:
					'<invoke name="inspect"><parameter name="label">bad</parameter><parameter name="count">not-a-number</parameter></invoke>',
			}),
		);
	});

	it("returns an empty argument object for a known invoke without parameters", () => {
		// given
		const text = '<invoke name="noop">\n</invoke>';

		// when
		const parsed = parseAnthropicXmlGeneratedText(text, [noopTool]);

		// then
		expect(parsed).toEqual([{ name: "noop", arguments: {} }]);
	});

	it.each([
		["no-parameter", noopTool],
		["optional-parameter", optionalTool],
	])("reports malformed parameter markup for a %s tool", (_description, tool) => {
		// given
		const onError = vi.fn();
		const text = `<invoke name="${tool.name}"><parameter name="ignored">unterminated</invoke>`;

		// when
		const parsed = parseAnthropicXmlGeneratedText(text, [tool], { onError });

		// then
		expect(parsed).toEqual([]);
		expect(onError).toHaveBeenCalledOnce();
		expect(onError).toHaveBeenCalledWith("Could not process anthropic-xml tool call, keeping original text.", {
			toolCall: text,
		});
	});

	it("stops cleanly at a truncated invoke after returning complete calls", () => {
		// given
		const text = '<invoke name="noop"></invoke><invoke name="Bash"><parameter name="command">echo incomplete';

		// when
		const parsed = parseAnthropicXmlGeneratedText(text, [noopTool, bashTool]);

		// then
		expect(parsed).toEqual([{ name: "noop", arguments: {} }]);
	});
});
