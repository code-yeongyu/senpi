import { describe, expect, it } from "vitest";
import { parseSettingsJson } from "../src/core/settings-json.ts";
import { SettingsJsonSyntaxError } from "../src/core/settings-json-syntax-error.ts";

function positionOf(content: string): { line: number; column: number } {
	try {
		parseSettingsJson(content);
	} catch (error) {
		if (error instanceof SettingsJsonSyntaxError) return { line: error.line, column: error.column };
		throw error;
	}
	throw new Error("expected a syntax error");
}

describe("settings JSON syntax error position", () => {
	it.each([
		["missing value", '{\n  "a": 1,\n  "theme":\n}\n', { line: 4, column: 1 }],
		["unclosed brace", '{\n  "a": 1\n', { line: 3, column: 1 }],
		["unquoted key", '{\n  "a": 1,\n  theme: "dark"\n}', { line: 3, column: 3 }],
		["stray token", '{\n  "a": 1\n  oops\n}', { line: 3, column: 3 }],
		["bad literal", '{"a": tru}', { line: 1, column: 10 }],
		["missing comma", '{"a": 1 "b": 2}', { line: 1, column: 9 }],
		["CRLF line breaks", '{\r\n  "a":\r\n}', { line: 3, column: 1 }],
		["error after comments", '{\n  // note\n  /* two\n  lines */\n  "a": :\n}', { line: 5, column: 8 }],
		["unterminated block comment", '{\n  "a": 1 /* open\n}', { line: 2, column: 10 }],
	])("reports the %s position", (_name, content, expected) => {
		expect(positionOf(content)).toEqual(expected);
	});

	it("still accepts comments and trailing commas", () => {
		expect(parseSettingsJson('{\n  // note\n  "a": [1, 2,],\n}')).toEqual({ a: [1, 2] });
	});
});
