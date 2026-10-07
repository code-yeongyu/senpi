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
