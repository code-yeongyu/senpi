import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inlineLocalImages } from "../../src/core/extensions/builtin/html-render/images.ts";

// senpi#6915: show_html_page inlines the local images a page loads and refuses a page whose loaded image is
// missing. Which paths count as loaded follows how a browser parses the page: only a loading context (src,
// srcset, poster, href, data and background attributes, url() in a style attribute or <style>, a quoted path
// in a <script> body or an inline handler) loads a path; any other attribute, raw text, a comment or a CDATA
// section only shows it, so it stays as written and never refuses the page.

const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DATA_URI = `data:image/png;base64,${PNG_HEAD.toString("base64")}`;

describe("senpi#6915: only a loading context loads a local image path", () => {
	let dir: string;
	let chart: string;
	let other: string;
	let missing: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "senpi-6915-"));
		chart = join(dir, "chart.png");
		other = join(dir, "other.png");
		missing = join(dir, "missing.png");
		writeFileSync(chart, PNG_HEAD);
		writeFileSync(other, PNG_HEAD);
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("ends an empty comment at once, so the image after it is inlined or reported missing", async () => {
		const shown = await inlineLocalImages(`<!--><img src="${chart}">`);
		const broken = await inlineLocalImages(`<!---><img src="${missing}">`);

		expect(shown).toEqual({ html: `<!--><img src="${DATA_URI}">`, missing: [] });
		expect(broken.missing).toEqual([missing]);
	});

	it("reads an apostrophe in an unquoted attribute value as part of the value, not as an opening quote", async () => {
		const html = `<p title=don't>Saved to "${missing}".</p><img alt=it's src="${chart}">`;

		const { html: inlined, missing: unread } = await inlineLocalImages(html);

		expect(unread).toEqual([]);
		expect(inlined).toBe(html.replace(chart, DATA_URI));
	});

	it.each([
		["alt", (path: string) => `<img alt="${path}">`],
		["title", (path: string) => `<a title="${path}">chart</a>`],
		["value", (path: string) => `<input value="${path}">`],
		["data-*", (path: string) => `<div data-shot="${path}"></div>`],
		["xmp", (path: string) => `<xmp><img src="${path}"></xmp>`],
		["noscript", (path: string) => `<noscript><img src="${path}"></noscript>`],
		["CDATA", (path: string) => `<![CDATA[<img src="${path}">]]>`],
		["CDATA in svg", (path: string) => `<svg><![CDATA[ a > <image href="${path}"/> ]]></svg>`],
	])("leaves a missing path only shown in %s as written", async (_where, page) => {
		const html = `${page(missing)}<img src="${chart}">`;

		const result = await inlineLocalImages(html);

		expect(result).toEqual({ html: html.replace(chart, DATA_URI), missing: [] });
	});

	it.each([
		["an unquoted src", (a: string) => `<img src=${a}>`],
		["a srcset with descriptors", (a: string, b: string) => `<img srcset="${a} 1x, ${b} 2x">`],
		["a video poster", (a: string) => `<video poster="${a}"></video>`],
		["a style attribute url()", (a: string) => `<div style="background: url('${a}')"></div>`],
		["a <style> url()", (a: string, b: string) => `<style>a{background:url("${a}")}b{background:url(${b})}</style>`],
		["an svg image href", (a: string, b: string) => `<svg><image href="${a}"/><image xlink:href="${b}"/></svg>`],
		["an object data", (a: string) => `<object data="${a}"></object>`],
		["a table background", (a: string) => `<table background="${a}"></table>`],
		["an inline handler", (a: string) => `<img onerror="this.src='${a}'" src="x">`],
		["a CDATA-like bogus comment ended before the tag", (a: string) => `<![CDATA[ a > <img src="${a}"> ]]>`],
	])("inlines the image %s loads", async (_where, page) => {
		const html = page(chart, other);

		const result = await inlineLocalImages(html);

		expect(result.missing).toEqual([]);
		expect(result.html).not.toContain(dir);
		expect(result.html).toContain(DATA_URI);
	});
});
