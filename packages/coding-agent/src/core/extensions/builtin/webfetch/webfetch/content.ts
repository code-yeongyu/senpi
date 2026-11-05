import { Readability } from "@mozilla/readability";
import TurndownService from "turndown/lib/turndown.browser.es.js";
import { applyWebDocumentUrl, normalizeWebUrls, parseWebDocument } from "./parse-web-document.ts";

interface ReadableArticle {
	readonly title: string;
	readonly root: HTMLElement;
	readonly hasHeading: boolean;
}

const BLOCK_BREAK_SELECTOR =
	"address, article, aside, blockquote, dd, div, dl, dt, figcaption, figure, footer, h1, h2, h3, h4, h5, h6, header, hr, li, main, nav, ol, p, pre, section, table, tbody, tfoot, thead, tr, ul";
const CELL_BREAK_SELECTOR = "td, th";
const WHITESPACE = /[\t\f\v \u00a0]+/g;
const NEWLINE_RUN = /\n{3,}/g;
const MIN_EXPLICIT_ARTICLE_TEXT_LENGTH = 30;
const EXPLICIT_ARTICLE_SELECTORS = [
	".article_view",
	".tt_article_useless_p_margin",
	".entry-content",
	".contents_style",
	".post-content",
	".article-content",
	".content-article",
	"#content .contents_style",
];
const TITLE_SELECTORS = [".tit_post", ".entry-title", ".post-title", ".article-title", "h1"];
const ARTICLE_NOISE_SELECTOR = [
	"script",
	"style",
	"noscript",
	"iframe",
	"object",
	"embed",
	"meta",
	"link",
	"nav",
	"aside",
	"footer",
	".another_category",
	".area_related",
	".related",
	".revenue_unit_wrap",
	".adsbygoogle",
	".container_postbtn",
	".postbtn_like",
	".comments",
	".comment",
	".tagTrail",
	".sidebar",
].join(", ");

const turndownService = new TurndownService({
	headingStyle: "atx",
	hr: "---",
	bulletListMarker: "-",
	codeBlockStyle: "fenced",
	emDelimiter: "*",
});
turndownService.remove(["script", "style", "noscript", "iframe", "object", "embed", "meta", "link"]);

export function htmlToMarkdown(html: string, url: string): string {
	const untouchedDocument = parseWebDocument(html, url);
	const article = extractReadableArticle(untouchedDocument);
	const root = article?.root ?? untouchedDocument.body;
	normalizeWebUrls(root, untouchedDocument);
	const markdown = normalizeMarkdown(turndownService.turndown(root));
	if (!article) return markdown;
	if (!article.title || article.hasHeading || markdown.startsWith(`# ${article.title}`)) return markdown;
	return `# ${article.title}\n\n${markdown}`.trim();
}

export function htmlToText(html: string, url: string): string {
	const untouchedDocument = parseWebDocument(html, url);
	const article = extractReadableArticle(untouchedDocument);
	if (article) {
		const body = htmlFragmentToPlainText(article.root);
		if (!article.title || article.hasHeading) return body;
		if (body.startsWith(article.title)) return body;
		return `${article.title}\n\n${body}`.trim();
	}

	return htmlFragmentToPlainText(untouchedDocument.body);
}

const SNAPSHOT_SKIP_SELECTOR = "script, style, noscript, template, svg, canvas, iframe, object, embed";
const SNAPSHOT_NAME_MAX_LENGTH = 100;
const SNAPSHOT_MAX_OPTIONS = 8;
const SNAPSHOT_LANDMARKS: Readonly<Record<string, string>> = {
	nav: "navigation",
	header: "banner",
	footer: "contentinfo",
	main: "main",
	aside: "complementary",
	form: "form",
};
const SNAPSHOT_LANDMARK_ROLES = new Set([
	"navigation",
	"banner",
	"contentinfo",
	"main",
	"complementary",
	"search",
	"form",
]);
const SNAPSHOT_BUTTON_INPUT_TYPES = new Set(["button", "submit", "reset", "image"]);
// Footnote markers ("[12]", "[a]", "^") point at the page's own reference list; they are not places to go.
const SNAPSHOT_FOOTNOTE_MARKER = /^(?:\[[^\]\s]{1,8}\]|\^)$/u;

/**
 * The page's navigation structure in document order, one element per line: headings, links with
 * their resolved target (same-origin links shortened to their path), buttons, form fields, and the
 * landmarks they sit in. Prose is left out; this is the map of where the page leads (senpi#5941).
 */
export function htmlToSnapshot(html: string, url: string): string {
	const document = parseWebDocument(html, url);
	const lines: string[] = [];
	const title = normalizeName(document.title);
	if (title && document.body.querySelector("h1") === null) lines.push(`# ${title}`);
	appendSnapshotLines(document.body, document, lines);
	const seenControls = new Set<string>();
	const kept = lines.filter((line, index) => {
		if (!line.startsWith("[")) return line !== lines[index - 1];
		if (seenControls.has(line)) return false;
		seenControls.add(line);
		return true;
	});
	// A landmark with nothing of its own before the next landmark (or the end) carries no navigation.
	return kept.filter((line, index) => !isLandmarkLine(line) || !isLandmarkLine(kept[index + 1] ?? "== ==")).join("\n");
}

function isLandmarkLine(line: string): boolean {
	return line.startsWith("== ") && line.endsWith(" ==");
}

function appendSnapshotLines(element: Element, document: Document, lines: string[]): void {
	for (const child of Array.from(element.children)) {
		if (child.matches(SNAPSHOT_SKIP_SELECTOR) || isHiddenElement(child)) continue;
		const line = snapshotLine(child, document);
		if (line === null) {
			appendSnapshotLines(child, document, lines);
			continue;
		}
		if (line !== "") lines.push(line);
		if (isLandmark(child)) appendSnapshotLines(child, document, lines);
	}
}

/** One element's line; `""` drops it and its subtree, `null` means it is a plain container. */
function snapshotLine(element: Element, document: Document): string | null {
	const tag = element.localName;
	const role = element.getAttribute("role")?.trim().toLowerCase();
	const heading = /^h([1-6])$/u.exec(tag);
	if (heading) {
		const name = accessibleName(element);
		return name ? `${"#".repeat(Number(heading[1]))} ${name}` : "";
	}
	if (tag === "a" && element.hasAttribute("href")) return linkLine(element, document);
	if (tag === "button" || role === "button") return `[button] ${accessibleName(element) || "(unnamed)"}`;
	if (tag === "input") return inputLine(element, document);
	if (tag === "textarea") return `[textarea] ${fieldLabel(element, document)}`;
	if (tag === "select") return selectLine(element, document);
	if (isLandmark(element)) {
		const label = normalizeName(element.getAttribute("aria-label") ?? "");
		return `== ${role && SNAPSHOT_LANDMARK_ROLES.has(role) ? role : SNAPSHOT_LANDMARKS[tag]}${label ? `: ${label}` : ""} ==`;
	}
	return null;
}

function isLandmark(element: Element): boolean {
	const role = element.getAttribute("role")?.trim().toLowerCase();
	return element.localName in SNAPSHOT_LANDMARKS || (role !== undefined && SNAPSHOT_LANDMARK_ROLES.has(role));
}

function isHiddenElement(element: Element): boolean {
	if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true") return true;
	const style = (element.getAttribute("style") ?? "").replace(/\s+/gu, "").toLowerCase();
	return style.includes("display:none") || style.includes("visibility:hidden");
}

function linkLine(element: Element, document: Document): string {
	const name = accessibleName(element);
	const href = element.getAttribute("href") ?? "";
	let destination: URL;
	try {
		destination = new URL(href, document.baseURI);
	} catch {
		return name ? `[${name}]` : "";
	}
	// oxlint-disable-next-line eslint/no-script-url -- a javascript: URL literal the code checks for, never navigated to
	if (destination.protocol === "javascript:") return name ? `[button] ${name}` : "";
	if (!name || SNAPSHOT_FOOTNOTE_MARKER.test(name)) return "";
	return `[${name}](${shortenSameOrigin(destination, document)})`;
}

function shortenSameOrigin(destination: URL, document: Document): string {
	const page = new URL(document.URL);
	if (destination.origin !== page.origin) return readableUrl(destination.href);
	const samePage = destination.pathname === page.pathname && destination.search === page.search;
	if (samePage && destination.hash) return readableUrl(destination.hash);
	return readableUrl(`${destination.pathname}${destination.search}${destination.hash}`);
}

/** Percent-decodes a URL for display (`/wiki/C%E1%BB%91c` -> `/wiki/Cốc`); undecodable input stays as it is. */
function readableUrl(value: string): string {
	try {
		return decodeURI(value);
	} catch {
		return value;
	}
}

function inputLine(element: Element, document: Document): string {
	const type = (element.getAttribute("type") ?? "text").trim().toLowerCase();
	if (type === "hidden") return "";
	if (SNAPSHOT_BUTTON_INPUT_TYPES.has(type)) {
		const name = normalizeName(
			element.getAttribute("value") ?? element.getAttribute("aria-label") ?? element.getAttribute("alt") ?? type,
		);
		return `[button] ${name}`;
	}
	return `[${type} input] ${fieldLabel(element, document)}`;
}

function selectLine(element: Element, document: Document): string {
	const options = Array.from(element.querySelectorAll("option"))
		.map((option) => normalizeName(option.textContent ?? ""))
		.filter((option) => option !== "");
	const shown = options.slice(0, SNAPSHOT_MAX_OPTIONS).join(" | ");
	const more = options.length > SNAPSHOT_MAX_OPTIONS ? ` | +${options.length - SNAPSHOT_MAX_OPTIONS} more` : "";
	return `[select] ${fieldLabel(element, document)}${shown ? `: ${shown}${more}` : ""}`;
}

function fieldLabel(element: Element, document: Document): string {
	const id = element.getAttribute("id");
	const forLabel = id
		? Array.from(document.querySelectorAll("label[for]")).find((label) => label.getAttribute("for") === id)
		: undefined;
	const candidates = [
		element.getAttribute("aria-label"),
		forLabel?.textContent,
		element.closest("label")?.textContent,
		element.getAttribute("placeholder"),
		element.getAttribute("title"),
		element.getAttribute("name"),
	];
	for (const candidate of candidates) {
		const name = normalizeName(candidate ?? "");
		if (name) return name;
	}
	return "(unlabeled)";
}

function accessibleName(element: Element): string {
	const label = normalizeName(element.getAttribute("aria-label") ?? "");
	if (label) return label;
	const text = normalizeName(element.textContent ?? "");
	if (text) return text;
	const image = element.querySelector("img[alt]");
	return normalizeName(image?.getAttribute("alt") ?? element.getAttribute("title") ?? "");
}

function normalizeName(value: string): string {
	const name = value.replace(/\s+/gu, " ").trim();
	return name.length > SNAPSHOT_NAME_MAX_LENGTH ? `${name.slice(0, SNAPSHOT_NAME_MAX_LENGTH - 1)}\u2026` : name;
}

function htmlFragmentToPlainText(root: HTMLElement): string {
	const document = root.ownerDocument;
	const clonedRoot = document.importNode(root, true);
	for (const element of clonedRoot.querySelectorAll("script, style, noscript, iframe, object, embed, meta, link")) {
		element.remove();
	}
	for (const element of clonedRoot.querySelectorAll("br")) {
		element.replaceWith(document.createTextNode("\n"));
	}
	for (const element of clonedRoot.querySelectorAll(CELL_BREAK_SELECTOR)) {
		element.after(document.createTextNode("\n"));
	}
	for (const element of clonedRoot.querySelectorAll(BLOCK_BREAK_SELECTOR)) {
		element.before(document.createTextNode("\n"));
		element.after(document.createTextNode("\n"));
	}
	return normalizePlainText(clonedRoot.textContent ?? "");
}

function extractReadableArticle(untouchedDocument: Document): ReadableArticle | undefined {
	for (const selector of EXPLICIT_ARTICLE_SELECTORS) {
		const candidate = untouchedDocument.querySelector<HTMLElement>(selector);
		if (!candidate) continue;
		const root = untouchedDocument.importNode(candidate, true);
		for (const noisyElement of root.querySelectorAll(ARTICLE_NOISE_SELECTOR)) noisyElement.remove();
		if (normalizePlainText(root.textContent ?? "").length < MIN_EXPLICIT_ARTICLE_TEXT_LENGTH) continue;
		return {
			title: selectPreferredTitle(untouchedDocument, untouchedDocument.title),
			root,
			hasHeading: root.querySelector("h1, h2, h3, h4, h5, h6") !== null,
		};
	}

	const document = applyWebDocumentUrl(untouchedDocument.importNode(untouchedDocument, true), untouchedDocument.URL);
	const article = new Readability(document, {
		charThreshold: 80,
		keepClasses: false,
		serializer: (element) => element,
	}).parse();
	if (!article?.content || !article.textContent) return undefined;
	const root = document.createElement("div");
	root.appendChild(article.content);
	return {
		title: selectPreferredTitle(document, article.title ?? ""),
		root,
		hasHeading: root.querySelector("h1, h2, h3, h4, h5, h6") !== null,
	};
}

function selectPreferredTitle(document: Document, fallback: string): string {
	for (const selector of TITLE_SELECTORS) {
		const title = normalizePlainText(document.querySelector(selector)?.textContent ?? "");
		if (title) return title;
	}
	return normalizePlainText(fallback);
}

function normalizePlainText(text: string): string {
	return text
		.replace(WHITESPACE, " ")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n[ \t]+/g, "\n")
		.replace(NEWLINE_RUN, "\n\n")
		.trim();
}

function normalizeMarkdown(markdown: string): string {
	return markdown
		.replace(/\r\n?/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n[ \t]+/g, "\n")
		.replace(NEWLINE_RUN, "\n\n")
		.trim();
}
