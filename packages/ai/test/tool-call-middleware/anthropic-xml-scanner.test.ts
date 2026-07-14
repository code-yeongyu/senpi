import { describe, expect, it } from "vitest";
import {
	findInvokeOpenTag,
	getSafeInvokeTextLength,
	scanInvokeBlock,
} from "../../src/tool-call-middleware/protocols/anthropic-xml/invoke-tag-scanner.ts";

function findInvokeCloseIndex(text: string, fromIndex: number): number {
	const block = scanInvokeBlock(text, { index: fromIndex, length: 0, toolName: "" });
	return block?.contentEnd ?? -1;
}

function parseParameterTags(inner: string) {
	const block = scanInvokeBlock(`${inner}</invoke>`, { index: 0, length: 0, toolName: "" });
	return block?.parameters ?? null;
}

describe("findInvokeOpenTag", () => {
	it("finds double-quoted invoke names and ignores a leading function_calls wrapper", () => {
		// given
		const text = '<function_calls>\n<invoke name="Bash">';

		// when
		const match = findInvokeOpenTag(text, 0);

		// then
		expect(match).toEqual({
			index: text.indexOf("<invoke"),
			length: '<invoke name="Bash">'.length,
			toolName: "Bash",
		});
	});

	it("finds single-quoted names with whitespace around the tag syntax", () => {
		// given
		const text = "prefix <  invoke  name = 'list_files'  >";

		// when
		const match = findInvokeOpenTag(text, 0);

		// then
		expect(match).toEqual({
			index: text.indexOf("<"),
			length: text.length - "prefix ".length,
			toolName: "list_files",
		});
	});

	it("starts searching at the requested index", () => {
		// given
		const text = '<invoke name="first"></invoke><invoke name="second">';

		// when
		const match = findInvokeOpenTag(text, text.indexOf("</invoke>") + "</invoke>".length);

		// then
		expect(match?.toolName).toBe("second");
	});
});

describe("findInvokeCloseIndex", () => {
	it("finds the first closing invoke tag after the content start", () => {
		// given
		const text = '<invoke name="Bash">body</invoke> trailing';

		// when
		const closeIndex = findInvokeCloseIndex(text, '<invoke name="Bash">'.length);

		// then
		expect(closeIndex).toBe(text.indexOf("</invoke>"));
	});

	it("ignores prompt-like invoke text inside a parameter value", () => {
		// given
		const text =
			'<invoke name="Bash"><parameter name="command">show <invoke name="Other">example</invoke> literally</parameter></invoke>';

		// when
		const closeIndex = findInvokeCloseIndex(text, '<invoke name="Bash">'.length);

		// then
		expect(closeIndex).toBe(text.lastIndexOf("</invoke>"));
	});
});

describe("parseParameterTags", () => {
	it("preserves parameter order and captures multiline values verbatim", () => {
		// given
		const inner = [
			'\n<parameter name="command">echo first</parameter>',
			"\n< parameter name = 'script' >line 1\n<value>\nline 2 > line 3</parameter>",
		].join("");

		// when
		const parameters = parseParameterTags(inner);

		// then
		expect(parameters).toEqual([
			{ name: "command", rawValue: "echo first" },
			{ name: "script", rawValue: "line 1\n<value>\nline 2 > line 3" },
		]);
	});

	it("returns an empty list when no parameter tags are present", () => {
		// given
		const inner = "plain invoke content";

		// when
		const parameters = parseParameterTags(inner);

		// then
		expect(parameters).toEqual([]);
	});

	it("rejects unclosed parameter markup instead of returning partial parameters", () => {
		// given
		const inner = '<parameter name="ignored">unterminated';

		// when
		const parameters = parseParameterTags(inner);

		// then
		expect(parameters).toBeNull();
	});
});

describe("getSafeInvokeTextLength", () => {
	it("withholds a partial invoke start from the text prefix", () => {
		// given
		const text = "prefix text <inv";

		// when
		const safeLength = getSafeInvokeTextLength(text);

		// then
		expect(safeLength).toBe(text.indexOf("<inv"));
	});

	it.each([
		"<parameter",
		"<function_calls",
		"< invoke name=",
		'<invoke name="Bash',
		"<invoke name='Bash'",
	])("withholds partial %s starts", (partialStart) => {
		// given
		const text = `prefix ${partialStart}`;

		// when
		const safeLength = getSafeInvokeTextLength(text);

		// then
		expect(safeLength).toBe(text.indexOf("<"));
	});

	it("emits an already-invalid closed invoke attribute with trailing content", () => {
		// given
		const text = 'prefix <invoke name="Bash" prose';

		// when
		const safeLength = getSafeInvokeTextLength(text);

		// then
		expect(findInvokeOpenTag(text, 0)).toBeNull();
		expect(safeLength).toBe(text.length);
	});

	it("returns the full length when no partial protocol start trails the text", () => {
		// given
		const text = "ordinary text with < and > characters";

		// when
		const safeLength = getSafeInvokeTextLength(text);

		// then
		expect(safeLength).toBe(text.length);
	});
});
