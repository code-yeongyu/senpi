import { describe, expect, it } from "vitest";
import {
	repairLoneSurrogates,
	repairStringsDeep,
	repairUnicodeEscapes,
} from "../../src/tool-call-middleware/protocols/antml/repair.ts";

describe("repairUnicodeEscapes", () => {
	it("escapes a broken \\u sequence so JSON.parse succeeds", () => {
		// given
		const brokenJson = String.raw`{"text":"bad\uZZZZescape"}`;

		// when
		const repaired = repairUnicodeEscapes(brokenJson);

		// then
		expect(() => JSON.parse(brokenJson)).toThrow();
		expect(JSON.parse(repaired)).toEqual({ text: String.raw`bad\uZZZZescape` });
	});

	it("escapes a truncated \\u sequence with fewer than four hex digits", () => {
		// given
		const brokenJson = String.raw`{"text":"cut\u12"}`;

		// when
		const repaired = repairUnicodeEscapes(brokenJson);

		// then
		expect(JSON.parse(repaired)).toEqual({ text: String.raw`cut\u12` });
	});

	it("leaves valid unicode escapes untouched", () => {
		// given
		const validJson = String.raw`{"text":"ok\u0041"}`;

		// when
		const repaired = repairUnicodeEscapes(validJson);

		// then
		expect(repaired).toBe(validJson);
		expect(JSON.parse(repaired)).toEqual({ text: "okA" });
	});

	it("leaves an escaped backslash before u untouched", () => {
		// given
		const validJson = String.raw`{"path":"C:\\users"}`;

		// when
		const repaired = repairUnicodeEscapes(validJson);

		// then
		expect(repaired).toBe(validJson);
		expect(JSON.parse(repaired)).toEqual({ path: String.raw`C:\users` });
	});
});

describe("repairLoneSurrogates", () => {
	it("replaces lone high and low surrogates with the replacement character", () => {
		// given
		const loneHigh = `bad${"\uD800"}end`;
		const loneLow = `bad${"\uDC00"}end`;

		// when / then
		expect(repairLoneSurrogates(loneHigh)).toBe("bad\uFFFDend");
		expect(repairLoneSurrogates(loneLow)).toBe("bad\uFFFDend");
	});

	it("keeps valid surrogate pairs intact", () => {
		// given
		const emoji = "ok\u{1F600}done";

		// when / then
		expect(repairLoneSurrogates(emoji)).toBe(emoji);
	});

	it("replaces a reversed surrogate pair entirely", () => {
		// given
		const reversed = `x${"\uDC00"}${"\uD800"}y`;

		// when / then
		expect(repairLoneSurrogates(reversed)).toBe("x\uFFFD\uFFFDy");
	});
});

describe("repairStringsDeep", () => {
	it("repairs lone surrogates in nested strings and keys", () => {
		// given
		const value = {
			[`k${"\uD800"}`]: [`v${"\uDC00"}`, 1, { inner: `w${"\uD800"}` }],
		};

		// when
		const repaired = repairStringsDeep(value);

		// then
		expect(repaired).toEqual({ "k\uFFFD": ["v\uFFFD", 1, { inner: "w\uFFFD" }] });
	});
});
