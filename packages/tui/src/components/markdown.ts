// allow: SIZE_OK - existing markdown renderer is oversized; this merge only preserves behavior and cache-key correctness.
import { Marked, type Token, Tokenizer, type TokenizerExtension, type Tokens } from "marked";
import {
	copyLineSources,
	getLineSources,
	type SourceLine,
	type SourceDocument,
	type SourceRange,
	setLineSource,
	setLineSources,
} from "../selection-source.ts";
import { concatRanges, emptyRanges, rangeAt, repeatedRange, sliceRanges, type SourceRanges } from "../source-ranges.ts";
import { getCapabilities, hyperlink, isImageLine } from "../terminal-image.ts";
import { type Component, nextRenderRevision } from "../tui.ts";
import {
	applyBackgroundToLine,
	flattenLines,
	stripTerminalSequences,
	visibleWidth,
	wrapTextWithAnsi,
} from "../utils.ts";
import { latexToUnicode } from "./latex.ts";
import { lexWithSources, sourceExtensions, tokenSource } from "./markdown-source.ts";

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

class StrictStrikethroughTokenizer extends Tokenizer {
	override del(src: string): Tokens.Del | undefined {
		const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
		if (!match) {
			return undefined;
		}

		const text = match[2];
		return {
			type: "del",
			raw: match[0],
			text,
			tokens: this.lexer.inlineTokens(text),
		};
	}
}

interface LatexToken extends Tokens.Generic {
	text: string;
	type: "latex_block" | "latex_inline" | "latex_literal";
}

const MAX_LATEX_FORMULA_LENGTH = 4096;
const WORD_CHARACTER_REGEX = /[\p{L}\p{M}\p{N}_]/u;

interface InlineCodePrefixState {
	hasUnclosedCodeSpan: boolean;
	lastProcessedRaw?: string;
	processedTokenCount: number;
}

const inlineCodePrefixStates = new WeakMap<Token[], InlineCodePrefixState>();

function createLatexToken(type: LatexToken["type"], raw: string, text: string): LatexToken {
	return { raw, text, type };
}

function isLatexToken(token: Token): token is LatexToken {
	return (
		(token.type === "latex_block" || token.type === "latex_inline" || token.type === "latex_literal") &&
		"text" in token &&
		typeof token.text === "string"
	);
}

function previousRawCharacter(tokens: Token[]): string | undefined {
	const raw = tokens[tokens.length - 1]?.raw;
	return raw ? Array.from(raw).at(-1) : undefined;
}

function firstCharacter(value: string): string | undefined {
	const codePoint = value.codePointAt(0);
	return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
}

function followsUnclosedCodeSpan(tokens: Token[]): boolean {
	let state = inlineCodePrefixStates.get(tokens);
	const previousProcessedToken = state ? tokens[state.processedTokenCount - 1] : undefined;
	if (!state || previousProcessedToken?.raw !== state.lastProcessedRaw) {
		state = { hasUnclosedCodeSpan: false, processedTokenCount: 0 };
		inlineCodePrefixStates.set(tokens, state);
	}

	for (let index = state.processedTokenCount; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (token?.type === "text" && token.raw.includes("`")) {
			state.hasUnclosedCodeSpan = true;
		}
	}
	state.processedTokenCount = tokens.length;
	state.lastProcessedRaw = tokens.at(-1)?.raw;
	return state.hasUnclosedCodeSpan;
}

function findInlineMath(
	src: string,
	open: "$" | "\\(" | "\\[",
	close: "$" | "\\)" | "\\]",
): { raw: string; text: string } | undefined {
	if (!src.startsWith(open)) return undefined;
	const bodyStart = open.length;
	const scanEnd = Math.min(src.length, bodyStart + MAX_LATEX_FORMULA_LENGTH + 1);

	for (let index = bodyStart; index < scanEnd; index += 1) {
		if (src[index] === "\n" || src[index] === "`") return undefined;
		if (src.startsWith(close, index)) {
			const text = src.slice(bodyStart, index);
			const normalizedText = open === close ? text : text.trim();
			if (!normalizedText || (open === close && /^\s|\s$/.test(text))) return undefined;
			return { raw: src.slice(0, index + close.length), text: normalizedText };
		}
		if (open !== close && src.startsWith(open, index)) return undefined;
		if (src[index] === "\\") {
			if (src[index + 1] === "\n" || src[index + 1] === "\r") return undefined;
			index += 1;
		}
	}
	return undefined;
}

function findMalformedInlineSpan(src: string, open: "\\(" | "\\[", close: "\\)" | "\\]"): string | undefined {
	if (!src.startsWith(open)) return undefined;
	const scanEnd = Math.min(src.length, open.length + MAX_LATEX_FORMULA_LENGTH + 1);
	let competingOpener = false;
	const closers = [close];
	for (let index = open.length; index < scanEnd; index += 1) {
		if (src[index] === "\n" || src[index] === "`") {
			return competingOpener ? src.slice(0, index) : undefined;
		}
		const nestedOpen = src.startsWith("\\(", index) ? "\\(" : src.startsWith("\\[", index) ? "\\[" : undefined;
		if (nestedOpen !== undefined) {
			competingOpener = true;
			closers.push(nestedOpen === "\\(" ? "\\)" : "\\]");
			index += nestedOpen.length - 1;
			continue;
		}
		const expectedClose = closers.at(-1);
		if (expectedClose !== undefined && src.startsWith(expectedClose, index)) {
			closers.pop();
			if (closers.length === 0) {
				return competingOpener ? src.slice(0, index + expectedClose.length) : undefined;
			}
			index += expectedClose.length - 1;
			continue;
		}
		if (src[index] === "\\") {
			if (src[index + 1] === "\n" || src[index + 1] === "\r") {
				return competingOpener ? src.slice(0, index) : undefined;
			}
			index += 1;
		}
	}
	return competingOpener ? src.slice(0, scanEnd) : undefined;
}

function isLikelyLiteralDollarBody(text: string): boolean {
	return (
		text.startsWith("{") ||
		/^\([^)\r\n]*\)[/\\]$/.test(text) ||
		/^[!#$?@*-][/\\]$/.test(text) ||
		/^[A-Za-z_][A-Za-z0-9_]*[./\\:-]$/.test(text) ||
		/^\d[\d,.]*(?:[-–—]|[/\\])$/.test(text)
	);
}

function findBlockMath(
	src: string,
	open: "$$" | "\\[",
	close: "$$" | "\\]",
): { raw: string; text: string } | undefined {
	if (!src.startsWith(open)) return undefined;
	const bodyStart = open.length;
	const scanEnd = Math.min(src.length, bodyStart + MAX_LATEX_FORMULA_LENGTH + 1);
	const lineValidationEnd = Math.min(src.length, scanEnd + close.length + 256);

	for (let index = bodyStart; index < scanEnd; index += 1) {
		if (src[index] === "`") return undefined;
		if (open !== close && src.startsWith(open, index)) return undefined;
		if (!src.startsWith(close, index)) continue;
		const closeEnd = index + close.length;
		let rawLineEnd = closeEnd;
		while (rawLineEnd < lineValidationEnd && src[rawLineEnd] !== "\n" && /[ \t]/.test(src[rawLineEnd] ?? "")) {
			rawLineEnd += 1;
		}
		if (rawLineEnd < src.length && src[rawLineEnd] !== "\n") return undefined;
		const text = src.slice(bodyStart, index).trim();
		if (!text) return undefined;
		let rawEnd = rawLineEnd;
		while (rawEnd < lineValidationEnd && src[rawEnd] === "\n") rawEnd += 1;
		return { raw: src.slice(0, rawEnd), text };
	}
	return undefined;
}

function repeatedMalformedOpeners(src: string, opener: "\\(" | "\\["): string | undefined {
	let end = opener.length;
	while (src.startsWith(opener, end)) end += opener.length;
	return end > opener.length ? src.slice(0, end) : undefined;
}

const blockMathTokenizer: TokenizerExtension = {
	name: "latex_block",
	level: "block",
	tokenizer(src) {
		const leadingSpaces = /^ {0,3}/.exec(src)?.[0] ?? "";
		const candidate = src.slice(leadingSpaces.length);
		const match = findBlockMath(candidate, "$$", "$$") ?? findBlockMath(candidate, "\\[", "\\]");
		if (match) return createLatexToken("latex_block", `${leadingSpaces}${match.raw}`, match.text);
		return undefined;
	},
};

const inlineMathTokenizer: TokenizerExtension = {
	name: "latex_inline",
	level: "inline",
	start(src) {
		const index = src.search(/\$|\\[()[\]]/);
		return index >= 0 ? index : undefined;
	},
	tokenizer(src, tokens) {
		const codeSpanLiteral = /^(?:\${1,2}|\\\(|\\\)|\\\[|\\\])/.exec(src)?.[0];
		if (codeSpanLiteral && followsUnclosedCodeSpan(tokens)) {
			return createLatexToken("latex_literal", codeSpanLiteral, codeSpanLiteral);
		}
		if (src.startsWith("$")) {
			if (src.startsWith("$$")) return createLatexToken("latex_literal", "$$", "$$");
			const match = findInlineMath(src, "$", "$");
			if (match && isLikelyLiteralDollarBody(match.text)) {
				return createLatexToken("latex_literal", match.raw, match.raw);
			}
			const previous = previousRawCharacter(tokens);
			const next = match ? firstCharacter(src.slice(match.raw.length)) : undefined;
			if (
				match &&
				(previous === undefined || !WORD_CHARACTER_REGEX.test(previous)) &&
				(next === undefined || !WORD_CHARACTER_REGEX.test(next))
			) {
				return createLatexToken("latex_inline", match.raw, match.text);
			}
			return createLatexToken("latex_literal", "$", "$");
		}
		const malformedParens = findMalformedInlineSpan(src, "\\(", "\\)");
		if (malformedParens) return createLatexToken("latex_literal", malformedParens, malformedParens);
		const malformedBrackets = findMalformedInlineSpan(src, "\\[", "\\]");
		if (malformedBrackets) return createLatexToken("latex_literal", malformedBrackets, malformedBrackets);
		const repeatedParens = repeatedMalformedOpeners(src, "\\(");
		if (repeatedParens) return createLatexToken("latex_literal", repeatedParens, repeatedParens);
		const repeatedBrackets = repeatedMalformedOpeners(src, "\\[");
		if (repeatedBrackets) return createLatexToken("latex_literal", repeatedBrackets, repeatedBrackets);
		const parens = findInlineMath(src, "\\(", "\\)");
		if (parens) {
			const previous = previousRawCharacter(tokens);
			const next = firstCharacter(src.slice(parens.raw.length));
			if (
				(previous === undefined || !WORD_CHARACTER_REGEX.test(previous)) &&
				(next === undefined || !WORD_CHARACTER_REGEX.test(next))
			) {
				return createLatexToken("latex_inline", parens.raw, parens.text);
			}
			return undefined;
		}
		const brackets = findInlineMath(src, "\\[", "\\]");
		if (brackets) {
			const previous = previousRawCharacter(tokens);
			const next = firstCharacter(src.slice(brackets.raw.length));
			if (
				(previous === undefined || !WORD_CHARACTER_REGEX.test(previous)) &&
				(next === undefined || !WORD_CHARACTER_REGEX.test(next))
			) {
				return createLatexToken("latex_inline", brackets.raw, brackets.text);
			}
			return undefined;
		}
		const literal = /^(?:\\\(|\\\)|\\\[|\\\])/.exec(src);
		if (!literal) return undefined;
		const previous = previousRawCharacter(tokens);
		return previous !== undefined && WORD_CHARACTER_REGEX.test(previous)
			? undefined
			: createLatexToken("latex_literal", literal[0], literal[0]);
	},
};

function trimPartialClosingFences(tokens: readonly Token[]): void {
	const token = tokens[tokens.length - 1];
	if (token?.type === "list") {
		trimPartialClosingFences(token.items[token.items.length - 1]?.tokens ?? []);
		return;
	}
	if (token?.type === "blockquote") {
		trimPartialClosingFences(token.tokens ?? []);
		return;
	}
	if (token?.type !== "code") {
		return;
	}

	// Trim streamed partial closing fences so code blocks do not shrink/flicker
	// when the final fence character arrives. See https://github.com/earendil-works/pi/issues/5825.
	const marker = /^(`{3,}|~{3,})/.exec(token.raw)?.[1];
	const lastLine = token.raw.split("\n").pop();
	if (!marker || !lastLine || lastLine.length >= marker.length || lastLine !== marker[0]?.repeat(lastLine.length)) {
		return;
	}

	token.text = token.text.slice(0, -lastLine.length).replace(/\n$/, "");
}

const markdownParser = new Marked();
markdownParser.use({ extensions: [blockMathTokenizer, inlineMathTokenizer] });
markdownParser.use({ extensions: sourceExtensions });
markdownParser.setOptions({
	tokenizer: new StrictStrikethroughTokenizer(),
});

const RENDER_CACHE_MAX = 256;
const PARSE_CACHE_MAX = 128;
// Original-source work is paid only on copy, with a small cache separate from normal rendering.
const SOURCE_CACHE_MAX = 8;
const CONTENT_KEY_CACHE_MAX = 128;
const HIGHLIGHT_CACHE_MAX = 512;
const MAX_HIGHLIGHT_BYTES = 200_000;
const MAX_HIGHLIGHT_LINES = 2000;
const renderCache = new Map<string, { source: string; transformed: string; lines: string[] }>();
const parseCache = new Map<string, { source: string; tokens: Token[] }>();
const sourceRenderCache = new Map<string, { source: string; transformed: string; lines: string[] }>();
const sourceParseCache = new Map<string, { source: string; tokens: Token[] }>();
const contentKeyCache = new Map<string, string>();
const highlightCache = new Map<string, string[]>();
const objectIds = new WeakMap<object, number>();
const enclosedTokens = new WeakSet<Token>();
let nextObjectId = 0;
let markdownHighlightCallCount = 0;

function objectId(value: object): number {
	const cached = objectIds.get(value);
	if (cached !== undefined) return cached;
	const id = nextObjectId++;
	objectIds.set(value, id);
	return id;
}

function cacheSet<T>(cache: Map<string, T>, key: string, value: T, maxSize: number): void {
	if (cache.has(key)) cache.delete(key);
	cache.set(key, value);
	if (cache.size > maxSize) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
}

function contentKey(text: string): string {
	const cached = contentKeyCache.get(text);
	if (cached !== undefined) {
		cacheSet(contentKeyCache, text, cached, CONTENT_KEY_CACHE_MAX);
		return cached;
	}

	let hash = 2166136261;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	const key = `${text.length}:${(hash >>> 0).toString(36)}`;
	cacheSet(contentKeyCache, text, key, CONTENT_KEY_CACHE_MAX);
	return key;
}

export function clearRenderCache(): void {
	renderCache.clear();
	parseCache.clear();
	sourceRenderCache.clear();
	sourceParseCache.clear();
	contentKeyCache.clear();
	highlightCache.clear();
}

export function getMarkdownHighlightCallCount(): number {
	return markdownHighlightCallCount;
}

export function resetMarkdownHighlightCallCount(): void {
	markdownHighlightCallCount = 0;
}

/**
 * Default text styling for markdown content.
 * Applied to all text unless overridden by markdown formatting.
 */
export interface DefaultTextStyle {
	/** Foreground color function */
	color?: (text: string) => string;
	/** Background color function */
	bgColor?: (text: string) => string;
	/** Bold text */
	bold?: boolean;
	/** Italic text */
	italic?: boolean;
	/** Strikethrough text */
	strikethrough?: boolean;
	/** Underline text */
	underline?: boolean;
}

/**
 * Theme functions for markdown elements.
 * Each function takes text and returns styled text with ANSI codes.
 */
export interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
	/** Inline `**strong**` text (default: `bold`). */
	strong?: (text: string) => string;
	/** Inline `*emphasis*` text (default: `italic`). */
	emphasis?: (text: string) => string;
	/** Inline `~~deleted~~` text (default: `strikethrough`). */
	deleted?: (text: string) => string;
	highlightCode?: (code: string, lang?: string) => string[];
	/** Prefix applied to each rendered code block line (default: "  ") */
	codeBlockIndent?: string;
}

export interface MarkdownOptions {
	/** Preserve source list markers instead of normalizing them. */
	preserveOrderedListMarkers?: boolean;
	/** Preserve source backslash escapes instead of normalizing escaped punctuation. */
	preserveBackslashEscapes?: boolean;
	/** Transform source Markdown before parsing, with the exact width available for content. */
	transform?: (markdown: string, availableWidth: number) => string;
	/** Render supported LaTeX math expressions as Unicode text (default: true). */
	renderLatex?: boolean;
}

interface InlineStyleContext {
	applyText: (text: string) => string;
	stylePrefix: string;
}

export class Markdown implements Component {
	private text: string;
	private paddingX: number; // Left/right padding
	private paddingY: number; // Top/bottom padding
	private defaultTextStyle?: DefaultTextStyle;
	private theme: MarkdownTheme;
	private options: MarkdownOptions;
	private defaultStylePrefix?: string;
	private activeSourceDocument?: SourceDocument;
	private collectSources = false;

	// Cache for rendered output
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private revision = nextRenderRevision();

	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
		options?: MarkdownOptions,
	) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.theme = theme;
		this.defaultTextStyle = defaultTextStyle;
		this.options = options ? { ...options } : {};
	}

	setText(text: string): void {
		this.text = text;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.activeSourceDocument = undefined;
		this.markRevision();
	}

	/** Instances that expose a revision advance the shared clock; others (e.g. an animated subclass) stay local. */
	private markRevision(): void {
		this.revision = this.getRenderRevision() === undefined ? this.revision + 1 : nextRenderRevision();
	}

	/** Exact `Markdown` instances only; a subclass may render more than its source text. */
	getRenderRevision(): number | undefined {
		return Object.getPrototypeOf(this) === Markdown.prototype ? this.revision : undefined;
	}

	render(width: number): string[] {
		// Check cache
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}

		// Calculate available width for content (subtract horizontal padding)
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const text = this.options.transform?.(this.text, contentWidth) ?? this.text;

		// Don't render anything if there's no actual text
		if (!text || text.trim() === "") {
			const result: string[] = [];
			// Update cache
			this.cachedText = this.text;
			this.cachedWidth = width;
			this.cachedLines = result;
			return result;
		}

		const styleKey = this.defaultTextStyle ? objectId(this.defaultTextStyle) : -1;
		const renderKey = [
			contentKey(this.text),
			contentKey(text),
			width,
			contentWidth,
			this.paddingX,
			this.paddingY,
			this.theme.codeBlockIndent ?? "  ",
			(this.options.preserveOrderedListMarkers ? 1 : 0) |
				(this.options.preserveBackslashEscapes ? 2 : 0) |
				(this.options.renderLatex === false ? 4 : 0),
			objectId(this.theme),
			styleKey,
			getCapabilities().images ?? "",
			getCapabilities().hyperlinks ? 1 : 0,
		].join("\x00");
		const selectedRenderCache = this.collectSources ? sourceRenderCache : renderCache;
		const cachedRender = selectedRenderCache.get(renderKey);
		if (cachedRender?.source === this.text && cachedRender.transformed === text) {
			this.cachedText = this.text;
			this.cachedWidth = width;
			this.cachedLines = this.ownSources(cachedRender.lines);
			return this.cachedLines;
		}

		// Parse markdown to HTML-like tokens
		const parseKey = contentKey(text);
		const selectedParseCache = this.collectSources ? sourceParseCache : parseCache;
		const cachedParse = selectedParseCache.get(parseKey);
		let tokens: Token[];
		if (cachedParse?.source === text) {
			tokens = cachedParse.tokens;
		} else {
			tokens = this.collectSources
				? lexWithSources(text, markdownParser.defaults)
				: markdownParser.lexer(text.replace(/\t/g, "   "));
			trimPartialClosingFences(tokens);
			cacheSet(
				selectedParseCache,
				parseKey,
				{ source: text, tokens },
				this.collectSources ? SOURCE_CACHE_MAX : PARSE_CACHE_MAX,
			);
		}

		// Convert tokens to styled terminal output
		this.activeSourceDocument = this.collectSources
			? (tokens.map((token) => tokenSource(token)?.raw.document).find((document) => document) ?? {
					text,
					enclosures: [],
				})
			: undefined;
		const renderedLines: string[] = [];

		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			const nextToken = tokens[i + 1];
			const tokenLines = this.renderToken(token, contentWidth, nextToken?.type);
			const offset = renderedLines.length;
			for (const tokenLine of tokenLines) {
				renderedLines.push(tokenLine);
			}
			copyLineSources(tokenLines, renderedLines, offset);
		}

		// Wrap lines (NO padding, NO background yet)
		const wrappedLines: string[] = [];
		for (let row = 0; row < renderedLines.length; row++) {
			const line = renderedLines[row];
			const mapping = getLineSources(renderedLines)?.[row];
			const offset = wrappedLines.length;
			if (isImageLine(line)) {
				wrappedLines.push(line);
			} else {
				const fragments = this.wrapSource(line, contentWidth, mapping);
				for (const wrappedLine of fragments) {
					wrappedLines.push(wrappedLine);
				}
				copyLineSources(fragments, wrappedLines, offset);
			}
		}
		// Add margins and background to each wrapped line
		const leftMargin = " ".repeat(this.paddingX);
		const rightMargin = " ".repeat(this.paddingX);
		const bgFn = this.defaultTextStyle?.bgColor;
		const contentLines: string[] = [];

		for (const line of wrappedLines) {
			if (isImageLine(line)) {
				contentLines.push(line);
				continue;
			}

			const lineWithMargins = leftMargin + line + rightMargin;

			if (bgFn) {
				contentLines.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
			} else {
				// No background - just pad to width
				const visibleLen = visibleWidth(lineWithMargins);
				const paddingNeeded = Math.max(0, width - visibleLen);
				contentLines.push(lineWithMargins + " ".repeat(paddingNeeded));
			}
		}

		copyLineSources(wrappedLines, contentLines, 0, this.paddingX);

		// Add top/bottom padding (empty lines)
		const emptyLine = " ".repeat(width);
		const emptyLines: string[] = [];
		for (let i = 0; i < this.paddingY; i++) {
			const line = bgFn ? applyBackgroundToLine(emptyLine, width, bgFn) : emptyLine;
			emptyLines.push(line);
		}

		// Combine top padding, content, and bottom padding
		const result = emptyLines.concat(contentLines, emptyLines);
		copyLineSources(contentLines, result, this.paddingY);
		const mapped = getLineSources(result);
		const document = mapped?.find((line) => line)?.document;
		if (document) {
			setLineSources(
				result,
				result.map((_, row) => mapped?.[row] ?? { document, ranges: emptyRanges }),
			);
		}
		if (text !== this.text) {
			const unavailableDocument = { text: this.text, enclosures: [] };
			setLineSources(
				result,
				result.map(() => ({ document: unavailableDocument, ranges: emptyRanges, unavailable: true })),
			);
		} else if (!this.collectSources) {
			// Capture values, not this component. Old cached frames must retain their own source.
			const sourceText = this.text;
			const { paddingX, paddingY, theme, defaultTextStyle } = this;
			const options = { ...this.options, transform: undefined };
			const deferred: SourceDocument = {
				text: sourceText,
				enclosures: [],
				resolveLines: () => {
					const markdown = new Markdown(sourceText, paddingX, paddingY, theme, defaultTextStyle, options);
					markdown.collectSources = true;
					const sourceLines = markdown.render(width);
					if (sourceLines.length !== result.length || sourceLines.some((line, row) => line !== result[row])) {
						return undefined;
					}
					return getLineSources(sourceLines);
				},
			};
			setLineSources(
				result,
				result.map((_, sourceRow) => ({
					document: deferred,
					ranges: emptyRanges,
					sourceRow,
				})),
			);
		}
		flattenLines(result);

		// Update cache
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = this.ownSources(result);
		cacheSet(
			selectedRenderCache,
			renderKey,
			{ source: this.text, transformed: text, lines: result },
			this.collectSources ? SOURCE_CACHE_MAX : RENDER_CACHE_MAX,
		);

		return this.cachedLines.length > 0 ? this.cachedLines : [""];
	}

	/** Shared render caches must not make two separate messages one source interval. */
	private ownSources(lines: string[]): string[] {
		const mapping = getLineSources(lines);
		if (!mapping) return lines;
		const original = mapping.find((line) => line)?.document;
		if (!original) return lines;
		const document = { ...original };
		const result = [...lines];
		setLineSources(
			result,
			mapping.map((line) => line && { ...line, document }),
		);
		return result;
	}

	private wrapSource(text: string, width: number, source?: SourceLine | null): string[] {
		const mapping: SourceLine[] = [];
		const lines = wrapTextWithAnsi(
			text,
			width,
			source
				? (start, end) => {
						mapping.push({ ...source, ranges: sliceRanges(source.ranges, start, end) });
					}
				: undefined,
		);
		if (source === null)
			setLineSources(
				lines,
				lines.map(() => null),
			);
		else if (source) setLineSources(lines, mapping);
		return lines;
	}

	private enclose(token: Token, ranges: SourceRanges): void {
		if (
			![
				"heading",
				"strong",
				"em",
				"del",
				"codespan",
				"code",
				"link",
				"image",
				"escape",
				"table",
				"blockquote",
			].includes(token.type)
		)
			return;
		if (enclosedTokens.has(token)) return;
		const source = tokenSource(token)?.raw;
		if (!source) return;
		const rawEnd = source.text.replace(/\n+$/, "").length;
		const start = rangeAt(source.ranges, 0)?.start;
		const end = rangeAt(source.ranges, rawEnd - 1)?.end;
		if (start === undefined || end === undefined) return;
		let contentStart = Infinity;
		let contentEnd = 0;
		for (const { source: range } of ranges.spans) {
			if (!range) continue;
			contentStart = Math.min(contentStart, range.start);
			contentEnd = Math.max(contentEnd, range.end);
		}
		if (contentStart === Infinity) return;
		enclosedTokens.add(token);
		source.document.enclosures.push({
			start,
			end,
			content: { start: contentStart, end: contentEnd },
		});
	}

	/**
	 * Apply default text style to a string.
	 * This is the base styling applied to all text content.
	 * NOTE: Background color is NOT applied here - it's applied at the padding stage
	 * to ensure it extends to the full line width.
	 */
	private applyDefaultStyle(text: string): string {
		if (!this.defaultTextStyle) {
			return text;
		}

		let styled = text;

		// Apply foreground color (NOT background - that's applied at padding stage)
		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		// Apply text decorations using this.theme
		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		return styled;
	}

	private getDefaultStylePrefix(): string {
		if (!this.defaultTextStyle) {
			return "";
		}

		if (this.defaultStylePrefix !== undefined) {
			return this.defaultStylePrefix;
		}

		const sentinel = "\u0000";
		let styled = sentinel;

		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		const sentinelIndex = styled.indexOf(sentinel);
		this.defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
		return this.defaultStylePrefix;
	}

	private getStylePrefix(styleFn: (text: string) => string): string {
		const sentinel = "\u0000";
		const styled = styleFn(sentinel);
		const sentinelIndex = styled.indexOf(sentinel);
		return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
	}

	private getDefaultInlineStyleContext(): InlineStyleContext {
		return {
			applyText: (text: string) => this.applyDefaultStyle(text),
			stylePrefix: this.getDefaultStylePrefix(),
		};
	}

	private exceedsHighlightCap(code: string): boolean {
		let newlineCount = 0;
		for (let i = 0; i < code.length; i++) {
			if (code.charCodeAt(i) === 10) newlineCount += 1;
			if (newlineCount + 1 > MAX_HIGHLIGHT_LINES) return true;
		}
		return new TextEncoder().encode(code).byteLength > MAX_HIGHLIGHT_BYTES;
	}

	private highlightCodeBlock(code: string, lang: string | undefined): string[] | null {
		if (!this.theme.highlightCode) return null;
		if (this.exceedsHighlightCap(code)) return null;
		const key = `${objectId(this.theme)}\x00${lang ?? ""}\x00${code}`;
		const cached = highlightCache.get(key);
		if (cached) {
			cacheSet(highlightCache, key, cached, HIGHLIGHT_CACHE_MAX);
			return cached;
		}
		markdownHighlightCallCount += 1;
		const highlighted = this.theme.highlightCode(code, lang);
		cacheSet(highlightCache, key, highlighted, HIGHLIGHT_CACHE_MAX);
		return highlighted;
	}

	private renderCodeBlock(lines: string[], code: string, lang: string | undefined, indent: string): void {
		lines.push(this.theme.codeBlockBorder(`\`\`\`${lang || ""}`));
		const highlightedLines = this.highlightCodeBlock(code, lang);
		if (highlightedLines) {
			for (const hlLine of highlightedLines) {
				lines.push(`${indent}${hlLine}`);
			}
		} else {
			if (this.theme.highlightCode && this.exceedsHighlightCap(code)) {
				lines.push(`${indent}${this.theme.codeBlock("[syntax highlighting skipped: code block too large]")}`);
			}
			for (const codeLine of code.split("\n")) {
				lines.push(`${indent}${this.theme.codeBlock(codeLine)}`);
			}
		}
		lines.push(this.theme.codeBlockBorder("```"));
	}

	private renderToken(
		token: Token,
		width: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];
		const inlineRanges: SourceRanges[] | undefined = this.collectSources ? [] : undefined;
		const source = tokenSource(token);

		switch (token.type) {
			case "heading": {
				const headingLevel = token.depth;
				const headingPrefix = `${"#".repeat(headingLevel)} `;

				// Build a heading-specific style context so inline tokens (codespan, bold, etc.)
				// restore heading styling after their own ANSI resets instead of falling back to
				// the default text style.
				let headingStyleFn: (text: string) => string;
				if (headingLevel === 1) {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(this.theme.underline(text)));
				} else {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(text));
				}

				const headingStyleContext: InlineStyleContext = {
					applyText: headingStyleFn,
					stylePrefix: this.getStylePrefix(headingStyleFn),
				};

				const headingText = this.renderInlineTokens(token.tokens || [], headingStyleContext, inlineRanges);
				const styledHeading = headingLevel >= 3 ? headingStyleFn(headingPrefix) + headingText : headingText;
				if (headingLevel >= 3 && inlineRanges) {
					const prefix = /^( {0,3})(#{3,6})([ \t]*)/.exec(source?.raw.text ?? "");
					if (source && prefix) {
						const start = prefix[1].length;
						const end = start + prefix[2].length;
						const separatorStart = rangeAt(source.raw.ranges, end);
						const separatorEnd = rangeAt(source.raw.ranges, end + prefix[3].length - 1);
						inlineRanges.unshift(
							concatRanges([
								sliceRanges(source.raw.ranges, start, end),
								repeatedRange(
									prefix[3].length && separatorStart && separatorEnd
										? { start: separatorStart.start, end: separatorEnd.end }
										: undefined,
									1,
								),
							]),
						);
					} else {
						inlineRanges.unshift(repeatedRange(undefined, headingPrefix.length));
					}
				}
				lines.push(styledHeading);
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after headings (unless space token follows)
				}
				break;
			}

			case "paragraph": {
				const paragraphText = this.renderInlineTokens(token.tokens || [], styleContext, inlineRanges);
				lines.push(paragraphText);
				// Don't add spacing if next token is space or list
				if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
					lines.push("");
				}
				break;
			}

			case "latex_block":
				if (isLatexToken(token)) {
					const formula = this.options.renderLatex === false ? token.raw.trim() : latexToUnicode(token.text);
					lines.push(styleContext ? styleContext.applyText(formula) : this.applyDefaultStyle(formula));
					if (nextTokenType && nextTokenType !== "space") {
						lines.push("");
					}
				}
				break;

			case "text":
				lines.push(this.renderInlineTokens([token], styleContext, inlineRanges));
				break;

			case "code": {
				const indent = this.theme.codeBlockIndent ?? "  ";
				this.renderCodeBlock(lines, token.text, token.lang, indent);
				if (source?.text) {
					const ranges: SourceLine[] = [];
					let offset = 0;
					const openingLength = /^[^\n]*/.exec(source.raw.text)?.[0].length ?? 0;
					const openingStart = rangeAt(source.raw.ranges, 0);
					const openingEnd = rangeAt(source.raw.ranges, openingLength - 1);
					const open =
						token.codeBlockStyle !== "indented" && openingStart && openingEnd
							? { start: openingStart.start, end: openingEnd.end }
							: undefined;
					ranges.push({
						document: source.raw.document,
						ranges: repeatedRange(open, stripTerminalSequences(lines[0]).length),
					});
					const codeLines = token.text.split("\n");
					for (let row = 1; row < lines.length - 1; row++) {
						const codeLine = codeLines[row - 1] ?? "";
						const rendered = stripTerminalSequences(lines[row]).slice(indent.length);
						ranges.push({
							document: source.raw.document,
							ranges: concatRanges([
								repeatedRange(undefined, indent.length),
								rendered === codeLine
									? sliceRanges(source.text.ranges, offset, offset + codeLine.length)
									: repeatedRange(null, rendered.length),
							]),
						});
						offset += codeLine.length + 1;
					}
					const marker = /^ {0,3}(`{3,}|~{3,})/.exec(source.raw.text)?.[1];
					const closing = marker
						? new RegExp(`\\n( {0,3}${marker[0]}{${marker.length},}[ \\t]*)\\n?$`).exec(source.raw.text)
						: null;
					const closeRanges = closing
						? sliceRanges(
								source.raw.ranges,
								closing.index + (closing[0].startsWith("\n") ? 1 : 0),
								source.raw.text.trimEnd().length,
							)
						: emptyRanges;
					const closingStart = rangeAt(closeRanges, 0);
					const closingEnd = rangeAt(closeRanges, closeRanges.length - 1);
					const close =
						closingStart && closingEnd ? { start: closingStart.start, end: closingEnd.end } : undefined;
					ranges.push({
						document: source.raw.document,
						ranges: repeatedRange(close, stripTerminalSequences(lines[lines.length - 1]).length),
					});
					setLineSources(lines, ranges);
					this.enclose(token, concatRanges(ranges.map((line) => line.ranges)));
				}
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after code blocks (unless space token follows)
				}
				break;
			}

			case "list": {
				const listLines = this.renderList(token as Tokens.List, 0, width, styleContext);
				lines.push(...listLines);
				copyLineSources(listLines, lines);
				// Don't add spacing after lists if a space token follows
				// (the space token will handle it)
				break;
			}

			case "table": {
				const tableLines = this.renderTable(token as Tokens.Table, width, nextTokenType, styleContext);
				lines.push(...tableLines);
				copyLineSources(tableLines, lines);
				break;
			}

			case "blockquote": {
				const quoteStyle = (text: string) => this.theme.quote(this.theme.italic(text));
				const quoteStylePrefix = this.getStylePrefix(quoteStyle);
				const applyQuoteStyle = (line: string): string => {
					if (!quoteStylePrefix) {
						return quoteStyle(line);
					}
					const lineWithReappliedStyle = line.replace(/\x1b\[0m/g, `\x1b[0m${quoteStylePrefix}`);
					return quoteStyle(lineWithReappliedStyle);
				};

				// Calculate available width for quote content (subtract border "│ " = 2 chars)
				const quoteContentWidth = Math.max(1, width - 2);

				// Blockquotes contain block-level tokens (paragraph, list, code, etc.), so render
				// children with renderToken() instead of renderInlineTokens().
				// Default message style should not apply inside blockquotes.
				const quoteInlineStyleContext: InlineStyleContext = {
					applyText: (text: string) => text,
					stylePrefix: quoteStylePrefix,
				};
				const quoteTokens = token.tokens || [];
				const renderedQuoteLines: string[] = [];
				for (let i = 0; i < quoteTokens.length; i++) {
					const quoteToken = quoteTokens[i];
					const nextQuoteToken = quoteTokens[i + 1];
					const childLines = this.renderToken(
						quoteToken,
						quoteContentWidth,
						nextQuoteToken?.type,
						quoteInlineStyleContext,
					);
					const offset = renderedQuoteLines.length;
					renderedQuoteLines.push(...childLines);
					copyLineSources(childLines, renderedQuoteLines, offset);
				}

				// Avoid rendering an extra empty quote line before the outer blockquote spacing.
				while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1] === "") {
					renderedQuoteLines.pop();
				}

				for (let row = 0; row < renderedQuoteLines.length; row++) {
					const quoteLine = renderedQuoteLines[row];
					const styledLine = applyQuoteStyle(quoteLine);
					const wrappedLines = this.wrapSource(
						styledLine,
						quoteContentWidth,
						getLineSources(renderedQuoteLines)?.[row],
					);
					const offset = lines.length;
					for (const wrappedLine of wrappedLines) {
						lines.push(this.theme.quoteBorder("│ ") + wrappedLine);
					}
					copyLineSources(wrappedLines, lines, offset, 2);
				}
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after blockquotes (unless space token follows)
				}
				break;
			}

			case "hr":
				lines.push(this.theme.hr("─".repeat(Math.min(width, 80))));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after horizontal rules (unless space token follows)
				}
				break;

			case "html":
				// Render HTML as plain text (escaped for terminal)
				if ("raw" in token && typeof token.raw === "string") {
					lines.push(this.applyDefaultStyle(token.raw.trim()));
				}
				break;

			case "space":
				// Space tokens represent blank lines in markdown
				lines.push("");
				break;

			default:
				// Handle any other token types as plain text
				if ("text" in token && typeof token.text === "string") {
					lines.push(token.text);
				}
		}

		if (source && !getLineSources(lines)) {
			const ranges = inlineRanges?.length
				? concatRanges(inlineRanges)
				: source.text?.text === stripTerminalSequences(lines[0] ?? "")
					? source.text.ranges
					: source.raw.text.trim() === stripTerminalSequences(lines[0] ?? "")
						? sliceRanges(
								source.raw.ranges,
								source.raw.text.length - source.raw.text.trimStart().length,
								source.raw.text.trimEnd().length,
							)
						: repeatedRange(null, stripTerminalSequences(lines[0] ?? "").length);
			setLineSources(
				lines,
				lines.map((_, row) => ({ document: source.raw.document, ranges: row === 0 ? ranges : emptyRanges })),
			);
			this.enclose(token, ranges);
		}
		if (!source && this.activeSourceDocument) {
			const document = this.activeSourceDocument;
			setLineSources(
				lines,
				lines.map(() => ({ document, ranges: emptyRanges, unavailable: true })),
			);
		} else if (token.type === "blockquote") {
			this.enclose(token, concatRanges((getLineSources(lines) ?? []).map((line) => line?.ranges ?? emptyRanges)));
		}
		return lines;
	}

	/**
	 * Render inline `strong`/`em`/`del` through a theme hook. The hook is applied inside the surrounding style context,
	 * so a color it sets wins over the heading or default text color instead of being overridden by it.
	 */
	private renderEmphasisHook(
		tokens: Token[],
		styleContext: InlineStyleContext,
		styleFn: (text: string) => string,
		ranges?: SourceRanges[],
	): string {
		const innerStyleContext: InlineStyleContext = {
			applyText: (text: string) => styleContext.applyText(styleFn(text)),
			stylePrefix: styleContext.stylePrefix + this.getStylePrefix(styleFn),
		};
		return styleFn(this.renderInlineTokens(tokens, innerStyleContext, ranges)) + styleContext.stylePrefix;
	}

	private renderInlineTokens(tokens: Token[], styleContext?: InlineStyleContext, ranges?: SourceRanges[]): string {
		let result = "";
		const resolvedStyleContext = styleContext ?? this.getDefaultInlineStyleContext();
		const { applyText, stylePrefix } = resolvedStyleContext;
		const applyTextWithNewlines = (text: string): string => {
			const segments: string[] = text.split("\n");
			return segments.map((segment: string) => applyText(segment)).join("\n");
		};

		for (const token of tokens) {
			const start = result.length;
			const childRanges: SourceRanges[] | undefined = ranges ? [] : undefined;
			switch (token.type) {
				case "escape":
					result += applyTextWithNewlines(this.options.preserveBackslashEscapes ? token.raw : token.text);
					break;

				case "text":
					// Text tokens in list items can have nested tokens for inline formatting
					if (token.tokens && token.tokens.length > 0) {
						result += this.renderInlineTokens(token.tokens, resolvedStyleContext, childRanges);
					} else {
						result += applyTextWithNewlines(token.text);
					}
					break;

				case "paragraph":
					// Paragraph tokens contain nested inline tokens
					result += this.renderInlineTokens(token.tokens || [], resolvedStyleContext, childRanges);
					break;

				case "strong": {
					if (this.theme.strong) {
						result += this.renderEmphasisHook(
							token.tokens || [],
							resolvedStyleContext,
							this.theme.strong,
							childRanges,
						);
						break;
					}
					const boldContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext, childRanges);
					result += this.theme.bold(boldContent) + stylePrefix;
					break;
				}

				case "em": {
					if (this.theme.emphasis) {
						result += this.renderEmphasisHook(
							token.tokens || [],
							resolvedStyleContext,
							this.theme.emphasis,
							childRanges,
						);
						break;
					}
					const italicContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext, childRanges);
					result += this.theme.italic(italicContent) + stylePrefix;
					break;
				}

				case "codespan":
					result += this.theme.code(token.text) + stylePrefix;
					break;

				case "latex_inline":
					if (isLatexToken(token)) {
						result += applyTextWithNewlines(
							this.options.renderLatex === false ? token.raw : latexToUnicode(token.text),
						);
					}
					break;

				case "latex_literal":
					if (isLatexToken(token)) {
						result += applyTextWithNewlines(token.text);
					}
					break;

				case "link": {
					const linkText = this.renderInlineTokens(token.tokens || [], resolvedStyleContext, childRanges);
					const styledLink = this.theme.link(this.theme.underline(linkText));
					if (getCapabilities().hyperlinks) {
						// OSC 8: render as a clickable hyperlink. The URL is not printed inline,
						// so we always show only the link text regardless of whether it matches href.
						result += hyperlink(styledLink, token.href) + stylePrefix;
					} else {
						// Fallback: print URL in parentheses when text differs from href.
						// Compare raw token.text (not styled) against href for the equality check.
						// For mailto: links strip the prefix (autolinked emails use text="foo@bar.com"
						// but href="mailto:foo@bar.com").
						const hrefForComparison = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
						if (token.text === token.href || token.text === hrefForComparison) {
							result += styledLink + stylePrefix;
						} else {
							result += styledLink + this.theme.linkUrl(` (${token.href})`) + stylePrefix;
						}
					}
					break;
				}

				case "br":
					result += "\n";
					break;

				case "del": {
					if (this.theme.deleted) {
						result += this.renderEmphasisHook(
							token.tokens || [],
							resolvedStyleContext,
							this.theme.deleted,
							childRanges,
						);
						break;
					}
					const delContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext, childRanges);
					result += this.theme.strikethrough(delContent) + stylePrefix;
					break;
				}

				case "html":
					// Render inline HTML as plain text
					if ("raw" in token && typeof token.raw === "string") {
						result += applyTextWithNewlines(token.raw);
					}
					break;

				default:
					// Handle any other inline token types as plain text
					if ("text" in token && typeof token.text === "string") {
						result += applyTextWithNewlines(token.text);
					}
			}
			if (!ranges) continue;
			const rendered = stripTerminalSequences(result.slice(start));
			const source = tokenSource(token);
			let mapped = childRanges?.length
				? concatRanges(childRanges)
				: source?.text?.text === rendered
					? source.text.ranges
					: source?.raw.text === rendered
						? source.raw.ranges
						: repeatedRange(null, rendered.length);
			if (token.type === "link" && mapped.length < rendered.length && source?.href) {
				mapped = concatRanges([
					mapped,
					repeatedRange(undefined, 2),
					source.href.ranges,
					repeatedRange(undefined, 1),
				]);
			}
			if (mapped.length < rendered.length) {
				mapped = concatRanges([mapped, repeatedRange(null, rendered.length - mapped.length)]);
			}
			ranges.push(mapped);
			this.enclose(token, token.type === "link" ? (source?.text?.ranges ?? mapped) : mapped);
		}

		while (stylePrefix && result.endsWith(stylePrefix)) {
			result = result.slice(0, -stylePrefix.length);
		}

		return result;
	}

	private getOrderedListMarker(item: Tokens.ListItem): string | undefined {
		const match = /^(?: {0,3})(\d{1,9}[.)])[ \t]+/.exec(item.raw);
		return match ? `${match[1]} ` : undefined;
	}

	private getUnorderedListMarker(item: Tokens.ListItem): string | undefined {
		const match = /^(?: {0,3})([-+*])(?:[ \t]+|(?=\r?\n|$))/.exec(item.raw);
		return match ? `${match[1]} ` : undefined;
	}

	/**
	 * Render a list with proper nesting support
	 */
	private renderList(token: Tokens.List, depth: number, width: number, styleContext?: InlineStyleContext): string[] {
		const lines: string[] = [];
		const indent = "    ".repeat(depth);
		// Use the list's start property (defaults to 1 for ordered lists)
		const startNumber = typeof token.start === "number" ? token.start : 1;

		for (let i = 0; i < token.items.length; i++) {
			const item = token.items[i];
			const isLastItem = i === token.items.length - 1;
			const bullet = token.ordered
				? this.options.preserveOrderedListMarkers
					? (this.getOrderedListMarker(item) ?? `${startNumber + i}. `)
					: `${startNumber + i}. `
				: this.options.preserveOrderedListMarkers
					? (this.getUnorderedListMarker(item) ?? "- ")
					: "- ";
			const taskMarker = item.task ? `[${item.checked ? "x" : " "}] ` : "";
			const marker = bullet + taskMarker;
			const firstPrefix = indent + this.theme.listBullet(marker);
			const continuationPrefix = indent + " ".repeat(visibleWidth(marker));
			const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
			let renderedAnyLine = false;

			for (const itemToken of item.tokens) {
				if (itemToken.type === "list") {
					const childLines = this.renderList(itemToken as Tokens.List, depth + 1, width, styleContext);
					const offset = lines.length;
					lines.push(...childLines);
					copyLineSources(childLines, lines, offset);
					renderedAnyLine = true;
					continue;
				}

				const itemLines = this.renderToken(itemToken, itemWidth, undefined, styleContext);
				for (let row = 0; row < itemLines.length; row++) {
					const line = itemLines[row];
					const fragments = this.wrapSource(line, itemWidth, getLineSources(itemLines)?.[row]);
					for (let part = 0; part < fragments.length; part++) {
						const wrappedLine = fragments[part];
						const linePrefix = renderedAnyLine ? continuationPrefix : firstPrefix;
						lines.push(linePrefix + wrappedLine);
						const source = getLineSources(fragments)?.[part];
						if (source) {
							let markerRange: SourceRange | undefined;
							if (!renderedAnyLine) {
								const raw = tokenSource(item)?.raw;
								const prefix = /^(?: {0,3})(?:[-+*]|\d{1,9}[.)])(?:[ \t]+|$)(?:\[[ xX]\][ \t]+)?/.exec(
									raw?.text ?? "",
								);
								if (raw && prefix?.[0].length) {
									const start = rangeAt(raw.ranges, 0)?.start;
									const end = rangeAt(raw.ranges, prefix[0].length - 1)?.end;
									if (start !== undefined && end !== undefined) markerRange = { start, end };
								}
							}
							setLineSource(lines, lines.length - 1, {
								...source,
								ranges: concatRanges([
									repeatedRange(undefined, indent.length),
									repeatedRange(markerRange, visibleWidth(linePrefix) - indent.length),
									source.ranges,
								]),
							});
						}
						renderedAnyLine = true;
					}
				}
			}

			if (!renderedAnyLine) {
				lines.push(firstPrefix);
				const raw = tokenSource(item)?.raw;
				const start = raw && rangeAt(raw.ranges, 0)?.start;
				const end = raw && rangeAt(raw.ranges, raw.ranges.length - 1)?.end;
				if (raw && start !== undefined && end !== undefined) {
					setLineSource(lines, lines.length - 1, {
						document: raw.document,
						ranges: repeatedRange({ start, end }, visibleWidth(firstPrefix)),
					});
				}
			}

			if (token.loose && !isLastItem) {
				lines.push("");
			}
		}
		const document = tokenSource(token)?.raw.document;
		if (document) {
			const mapping = getLineSources(lines);
			setLineSources(
				lines,
				lines.map((_, row) => mapping?.[row] ?? { document, ranges: emptyRanges }),
			);
		}

		return lines;
	}

	/**
	 * Get the visible width of the longest word in a string.
	 */
	private getLongestWordWidth(text: string, maxWidth?: number): number {
		const words = text.split(/\s+/).filter((word) => word.length > 0);
		let longest = 0;
		for (const word of words) {
			longest = Math.max(longest, visibleWidth(word));
		}
		if (maxWidth === undefined) {
			return longest;
		}
		return Math.min(longest, maxWidth);
	}

	/**
	 * Wrap a table cell to fit into a column.
	 *
	 * Delegates to wrapTextWithAnsi() so ANSI codes + long tokens are handled
	 * consistently with the rest of the renderer.
	 */
	private wrapCellText(text: string, maxWidth: number, stylePrefix = "", source?: SourceLine): string[] {
		const lines = this.wrapSource(text, Math.max(1, maxWidth), source);
		return copyLineSources(
			lines,
			lines.map((line, index) => {
				// Reset text styles after each non-final fragment, then restore the surrounding style before padding and borders.
				const styleReset = index < lines.length - 1 ? "\x1b[22;23;24;25;27;28;29;39m" : "";
				return `${line}${styleReset}${stylePrefix}`;
			}),
		);
	}

	/**
	 * Render a table with width-aware cell wrapping.
	 * Cells that don't fit are wrapped to multiple lines.
	 */
	private renderTable(
		token: Tokens.Table,
		availableWidth: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];
		const source = tokenSource(token)?.raw;
		const numCols = token.header.length;

		if (numCols === 0) {
			return lines;
		}

		// Calculate border overhead: "│ " + (n-1) * " │ " + " │"
		// = 2 + (n-1) * 3 + 2 = 3n + 1
		const borderOverhead = 3 * numCols + 1;
		const availableForCells = availableWidth - borderOverhead;
		if (availableForCells < numCols) {
			// Too narrow to render a stable table. Fall back to raw markdown.
			const fallbackLines = token.raw
				? this.wrapSource(
						token.raw,
						availableWidth,
						source && { document: source.document, ranges: sliceRanges(source.ranges, 0, token.raw.length) },
					)
				: [];
			if (nextTokenType && nextTokenType !== "space") {
				fallbackLines.push("");
			}
			return fallbackLines;
		}

		const maxUnbrokenWordWidth = 30;

		// Calculate natural column widths (what each column needs without constraints)
		const naturalWidths: number[] = [];
		const minWordWidths: number[] = [];
		for (let i = 0; i < numCols; i++) {
			const headerText = this.renderInlineTokens(token.header[i].tokens || [], styleContext);
			naturalWidths[i] = visibleWidth(headerText);
			minWordWidths[i] = Math.max(1, this.getLongestWordWidth(headerText, maxUnbrokenWordWidth));
		}
		for (const row of token.rows) {
			for (let i = 0; i < row.length; i++) {
				const cellText = this.renderInlineTokens(row[i].tokens || [], styleContext);
				naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText));
				minWordWidths[i] = Math.max(
					minWordWidths[i] || 1,
					this.getLongestWordWidth(cellText, maxUnbrokenWordWidth),
				);
			}
		}

		let minColumnWidths = minWordWidths;
		let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);

		if (minCellsWidth > availableForCells) {
			minColumnWidths = new Array(numCols).fill(1);
			const remaining = availableForCells - numCols;

			if (remaining > 0) {
				const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
				const growth = minWordWidths.map((width) => {
					const weight = Math.max(0, width - 1);
					return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
				});

				for (let i = 0; i < numCols; i++) {
					minColumnWidths[i] += growth[i] ?? 0;
				}

				const allocated = growth.reduce((total, width) => total + width, 0);
				let leftover = remaining - allocated;
				for (let i = 0; leftover > 0 && i < numCols; i++) {
					minColumnWidths[i]++;
					leftover--;
				}
			}

			minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
		}

		// Calculate column widths that fit within available width
		const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead;
		let columnWidths: number[];

		if (totalNaturalWidth <= availableWidth) {
			// Everything fits naturally
			columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index]));
		} else {
			// Need to shrink columns to fit
			const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
				return total + Math.max(0, width - minColumnWidths[index]);
			}, 0);
			const extraWidth = Math.max(0, availableForCells - minCellsWidth);
			columnWidths = minColumnWidths.map((minWidth, index) => {
				const naturalWidth = naturalWidths[index];
				const minWidthDelta = Math.max(0, naturalWidth - minWidth);
				let grow = 0;
				if (totalGrowPotential > 0) {
					grow = Math.floor((minWidthDelta / totalGrowPotential) * extraWidth);
				}
				return minWidth + grow;
			});

			// Adjust for rounding errors - distribute remaining space
			const allocated = columnWidths.reduce((a, b) => a + b, 0);
			let remaining = availableForCells - allocated;
			while (remaining > 0) {
				let grew = false;
				for (let i = 0; i < numCols && remaining > 0; i++) {
					if (columnWidths[i] < naturalWidths[i]) {
						columnWidths[i]++;
						remaining--;
						grew = true;
					}
				}
				if (!grew) {
					break;
				}
			}
		}

		// Render top border
		const topBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(`┌─${topBorderCells.join("─┬─")}─┐`);

		// Render header with wrapping
		const headerCellLines: string[][] = token.header.map((cell, i) => {
			const ranges: SourceRanges[] | undefined = this.collectSources ? [] : undefined;
			const text = this.renderInlineTokens(cell.tokens || [], styleContext, ranges);
			return this.wrapCellText(
				text,
				columnWidths[i],
				styleContext?.stylePrefix,
				source && { document: source.document, ranges: concatRanges(ranges ?? []) },
			);
		});
		const headerLineCount = Math.max(...headerCellLines.map((c) => c.length));

		for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
			const rowParts = headerCellLines.map((cellLines, colIdx) => {
				const text = cellLines[lineIdx] || "";
				const padded = text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				return this.theme.bold(padded);
			});
			lines.push(`│ ${rowParts.join(" │ ")} │`);
			if (source) this.mapTableRow(lines, headerCellLines, lineIdx, columnWidths, source.document);
		}

		// Render separator
		const separatorCells = columnWidths.map((w) => "─".repeat(w));
		const separatorLine = `├─${separatorCells.join("─┼─")}─┤`;
		lines.push(separatorLine);

		// Render rows with wrapping
		for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
			const row = token.rows[rowIndex];
			const rowCellLines: string[][] = row.map((cell, i) => {
				const ranges: SourceRanges[] | undefined = this.collectSources ? [] : undefined;
				const text = this.renderInlineTokens(cell.tokens || [], styleContext, ranges);
				return this.wrapCellText(
					text,
					columnWidths[i],
					styleContext?.stylePrefix,
					source && { document: source.document, ranges: concatRanges(ranges ?? []) },
				);
			});
			const rowLineCount = Math.max(...rowCellLines.map((c) => c.length));

			for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
				const rowParts = rowCellLines.map((cellLines, colIdx) => {
					const text = cellLines[lineIdx] || "";
					return text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				});
				lines.push(`│ ${rowParts.join(" │ ")} │`);
				if (source) this.mapTableRow(lines, rowCellLines, lineIdx, columnWidths, source.document);
			}

			if (rowIndex < token.rows.length - 1) {
				lines.push(separatorLine);
			}
		}

		// Render bottom border
		const bottomBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(`└─${bottomBorderCells.join("─┴─")}─┘`);

		if (nextTokenType && nextTokenType !== "space") {
			lines.push(""); // Add spacing after table
		}
		if (source) {
			const mapping = getLineSources(lines);
			setLineSources(
				lines,
				lines.map((_, row) => mapping?.[row] ?? { document: source.document, ranges: emptyRanges }),
			);
			this.enclose(token, concatRanges((getLineSources(lines) ?? []).map((line) => line?.ranges ?? emptyRanges)));
		}
		return lines;
	}

	private mapTableRow(
		lines: string[],
		cells: string[][],
		row: number,
		widths: number[],
		document: SourceLine["document"],
	): void {
		const ranges: SourceRanges[] = [repeatedRange(undefined, 2)];
		for (let col = 0; col < cells.length; col++) {
			const text = cells[col][row] ?? "";
			const cell = getLineSources(cells[col])?.[row];
			ranges.push(cell?.ranges ?? emptyRanges);
			ranges.push(repeatedRange(undefined, Math.max(0, widths[col] - visibleWidth(text)) + 3));
		}
		setLineSource(lines, lines.length - 1, { document, ranges: concatRanges(ranges) });
	}
}
