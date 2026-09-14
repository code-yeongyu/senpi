import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../../src/core/extensions/builtin/webfetch/webfetch/content.ts";
import {
	applyWebDocumentUrl,
	normalizeWebUrls,
	parseWebDocument,
} from "../../src/core/extensions/builtin/webfetch/webfetch/parse-web-document.ts";

const finalUrl = "https://example.test/posts/final";

describe("webfetch document boundaries", () => {
	it("retains document identity when cloning for reader extraction", () => {
		// Given
		const source = parseWebDocument(
			'<base href="../assets/"><base href="https://ignored.test/"><p>Article</p>',
			finalUrl,
		);
		// When
		const clone = applyWebDocumentUrl(source.importNode(source, true), finalUrl);
		// Then
		expect([clone.URL, clone.documentURI, clone.baseURI]).toEqual([
			finalUrl,
			finalUrl,
			"https://example.test/assets/",
		]);
	});

	it("uses the final URL when the first base is malformed", () => {
		// Given / When
		const document = parseWebDocument(
			'<base href="http://["><base href="https://ignored.test/"><p>Article</p>',
			finalUrl,
		);
		// Then
		expect(document.baseURI).toBe(finalUrl);
	});

	for (const destination of [
		"mailto:reader@example.test",
		"tel:+12025550123",
		"data:image/png;base64,AA==",
		"http://[",
	]) {
		it(`preserves the destination when it is ${destination}`, () => {
			// Given
			const document = parseWebDocument(`<a href="${destination}">Link</a><img src="${destination}">`, finalUrl);
			// When
			normalizeWebUrls(document.body, document);
			// Then
			expect([
				document.querySelector("a")?.getAttribute("href"),
				document.querySelector("img")?.getAttribute("src"),
			]).toEqual([destination, destination]);
		});
	}

	it("unwraps script links while preserving nested inline children", () => {
		// Given
		const document = parseWebDocument('<a href=" JaVaScRiPt:alert(1)"><strong>Nested</strong> text</a>', finalUrl);
		// When
		normalizeWebUrls(document.body, document);
		// Then
		expect(document.querySelector("a")).toBeNull();
		expect(document.querySelector("strong")?.textContent).toBe("Nested");
		expect(document.body.textContent).toBe("Nested text");
	});

	it("keeps input inert when it contains executable script and event handlers", () => {
		// Given
		const globals = [Reflect.get(globalThis, "window"), Reflect.get(globalThis, "document")];
		const sentinel = "__webfetch_executed__";
		// When
		parseWebDocument(
			`<script>globalThis.${sentinel} = true</script><img src="https://invalid.test/asset" onerror="globalThis.${sentinel} = true">`,
			finalUrl,
		);
		// Then
		expect(Reflect.has(globalThis, sentinel)).toBe(false);
		expect([Reflect.get(globalThis, "window"), Reflect.get(globalThis, "document")]).toEqual(globals);
	});

	it("keeps URL state isolated when converting consecutive pages", () => {
		// Given
		const html =
			'<div class="article_view"><p>Article content long enough for explicit selection with a <a href="child">link</a>.</p></div>';
		htmlToMarkdown(html, "https://previous.test/first/");
		// When
		const markdown = htmlToMarkdown(html, finalUrl);
		// Then
		expect(markdown).toContain("](https://example.test/posts/child)");
		expect(markdown).not.toContain("previous.test");
	});
});
