import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { htmlToMarkdown, htmlToText } from "../../src/core/extensions/builtin/webfetch/webfetch/content.ts";
import {
	capWebfetchOutput,
	DEFAULT_OUTPUT_MAX_BYTES,
} from "../../src/core/extensions/builtin/webfetch/webfetch/tool.ts";

const fixtures = [
	"01-reader",
	"02-explicit",
	"03-tistory",
	"04-title",
	"05-lines",
	"06-entities",
	"07-redirect",
	"08-readable-urls",
	"09-explicit-urls",
	"10-base-redirect",
	"11-malformed",
	"12-multibyte",
	"13-omitted-body",
	"14-html-in-comment-script",
	"15-fragment",
] as const;
// Recorded final URL: fixture 10 is served after /fixtures/base/start redirects here.
const finalUrl = "https://example.test/fixtures/base/final";
const fixtureDirectory = new URL("../fixtures/webfetch/", import.meta.url);

function normalize(value: string): string {
	return value
		.replace(/\r\n/g, "\n")
		.replace(/[\t ]+$/gm, "")
		.replace(/\n$/, "");
}

describe("webfetch base-implementation goldens", () => {
	for (const fixture of fixtures) {
		for (const format of ["md", "txt"] as const) {
			it(`preserves ${format} output when converting ${fixture}`, () => {
				// Given: verbatim legacy fixtures or deterministic URL, malformed, and size boundaries.
				const html = readFileSync(new URL(`${fixture}.html`, fixtureDirectory), "utf8");
				const goldenPath = new URL(`${fixture}.${format}.golden`, fixtureDirectory);
				let expected = readFileSync(goldenPath, "utf8");
				// Allowed delta only: fixture 8 already has absolute URLs from Readability.
				// Fixture 9 resolves guide/image against finalUrl and preserves #section.
				// Fixture 10 resolves all three destinations against the first base href.
				if (format === "md" && (fixture === "09-explicit-urls" || fixture === "10-base-redirect")) {
					const base = fixture === "10-base-redirect" ? new URL("../assets/", finalUrl).href : finalUrl;
					expected = expected.replace(
						/\]\((\.\.\/guide|images\/example\.png|#section)\)/g,
						(match, value: string) => {
							if (value.startsWith("#") && base === finalUrl) return match;
							return `](${new URL(value, base).href})`;
						},
					);
				}
				// When
				const actual = format === "md" ? htmlToMarkdown(html, finalUrl) : htmlToText(html, finalUrl);
				// Then: no normalization of actual destinations can hide a URL regression.
				expect(normalize(actual)).toBe(normalize(expected));
			});
		}
	}

	for (const [fixture, omitted, condition] of [
		["13-omitted-body", /<\/?(?:html|head)>/g, "html and head tags are omitted"],
		["14-html-in-comment-script", /<!--.*?-->/, "only the script contains an html string"],
		["14-html-in-comment-script", /<script>.*?<\/script>/, "only the comment contains an html string"],
	] as const) {
		for (const format of ["md", "txt"] as const) {
			it(`preserves ${format} output when ${condition}`, () => {
				// Given: these variants were independently compared with the same jsdom goldens.
				const html = readFileSync(new URL(`${fixture}.html`, fixtureDirectory), "utf8").replace(omitted, "");
				const expected = readFileSync(new URL(`${fixture}.${format}.golden`, fixtureDirectory), "utf8");
				// When
				const actual = format === "md" ? htmlToMarkdown(html, finalUrl) : htmlToText(html, finalUrl);
				// Then
				expect(normalize(actual)).toBe(normalize(expected));
			});
		}
	}

	it("caps complete UTF-8 output when the multibyte article exceeds 50 KiB", () => {
		// Given
		const html = readFileSync(new URL("12-multibyte.html", fixtureDirectory), "utf8");
		const markdown = htmlToMarkdown(html, finalUrl);
		// When
		const capped = capWebfetchOutput(markdown);
		// Then
		expect(capped.truncated).toBe(true);
		expect(capped.totalBytes).toBeGreaterThan(DEFAULT_OUTPUT_MAX_BYTES);
		expect(capped.outputBytes).toBeLessThanOrEqual(DEFAULT_OUTPUT_MAX_BYTES);
		expect(capped.text).not.toContain("\uFFFD");
	});
});
