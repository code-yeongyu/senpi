import { describe, expect, it } from "vitest";
import { decodeJsonStringBytes } from "../../src/core/session-json-string-bytes.ts";

// senpi#3968: a paged body is decoded straight from its bytes; it must equal JSON.parse on every literal it accepts.
const decode = (literal: string): string | undefined => {
	const bytes = Buffer.from(literal, "utf8");
	return decodeJsonStringBytes(bytes, Buffer.alloc(bytes.length));
};

describe("decoding a JSON string literal from its UTF-8 bytes", () => {
	it.each([
		"plain ascii",
		"line one\nline two\r\n\ttabbed",
		'quotes " and backslashes \\ and a slash /',
		"control \b\f and nul \u0000 and \u001f",
		"non-ascii: 한국어 ü € 𝄞 😀",
		"a\u2028b\u2029c",
		"",
		"x".repeat(100_000),
	])("matches JSON.parse for %j", (value) => {
		const literal = JSON.stringify(value);
		expect(decode(literal)).toBe(JSON.parse(literal));
	});

	it("matches JSON.parse for escapes a writer other than JSON.stringify may use", () => {
		for (const literal of ['"\\u0041\\u00e9\\u20ac"', '"\\ud83d\\ude00"', '"\\/path\\/x"', '"\\u000A"']) {
			expect(decode(literal)).toBe(JSON.parse(literal));
		}
	});

	it("returns undefined, never a wrong string, for what it does not decode", () => {
		for (const literal of [
			'"\\ud83d"',
			'"\\ude00"',
			'"\\x41"',
			'"\\u12G4"',
			'"raw\ncontrol"',
			'"unterminated',
			'x"y"',
			'"a"b"',
		]) {
			expect(decode(literal)).toBeUndefined();
		}
	});
});
