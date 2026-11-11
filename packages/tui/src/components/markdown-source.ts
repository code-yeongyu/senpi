import { Lexer, type MarkedOptions, type Token, type TokenizerExtension, type TokensList } from "marked";
import type { SourceDocument } from "../selection-source.ts";
import { concatRanges, linearRanges, repeatedRange, sliceRanges, type SourceRanges } from "../source-ranges.ts";

interface MappedText {
	readonly text: string;
	readonly ranges: SourceRanges;
	readonly document: SourceDocument;
}

interface Frame {
	readonly text: string;
	offset: number;
	count: number;
	lastRaw?: string;
}

const locations = new WeakMap<Token, { frame: Frame; start: number; end: number }>();
const tokenSources = new WeakMap<Token, { raw: MappedText; text?: MappedText; href?: MappedText }>();

/** Observe actual consumed lexer input, including tokens Marked merges or discards. */
class SourceLexer extends Lexer {
	private frame?: Frame;

	record(remaining: string, tokens: Token[]): void {
		const frame = this.frame;
		if (!frame) return;
		const offset = frame.text.length - remaining.length;
		const last = tokens.at(-1);
		if (last && (tokens.length !== frame.count || last.raw !== frame.lastRaw)) {
			const previous = locations.get(last);
			locations.set(last, {
				frame,
				start: previous?.frame === frame ? previous.start : frame.offset,
				end: offset,
			});
		}
		frame.offset = offset;
		frame.count = tokens.length;
		frame.lastRaw = last?.raw;
	}

	override blockTokens(src: string, tokens?: Token[], clipped?: boolean): Token[];
	override blockTokens(src: string, tokens?: TokensList, clipped?: boolean): TokensList;
	override blockTokens(src: string, tokens: Token[] = [], clipped = false): Token[] {
		const outer = this.frame;
		this.frame = { text: src, offset: 0, count: tokens.length, lastRaw: tokens.at(-1)?.raw };
		try {
			const result = super.blockTokens(src, tokens, clipped);
			this.record("", result);
			return result;
		} finally {
			this.frame = outer;
		}
	}

	override inlineTokens(src: string, tokens: Token[] = []): Token[] {
		const outer = this.frame;
		this.frame = { text: src, offset: 0, count: tokens.length, lastRaw: tokens.at(-1)?.raw };
		try {
			const result = super.inlineTokens(src, tokens);
			this.record("", result);
			return result;
		} finally {
			this.frame = outer;
		}
	}
}

export const sourceExtensions: TokenizerExtension[] = ["block", "inline"].map((level) => ({
	name: `source_${level}`,
	level: level === "block" ? "block" : "inline",
	tokenizer(src, tokens = []) {
		if (this.lexer instanceof SourceLexer) this.lexer.record(src, tokens);
		return undefined;
	},
}));

function sliceSource(source: MappedText, start: number, end = source.text.length): MappedText {
	return {
		document: source.document,
		text: source.text.slice(start, end),
		ranges: sliceRanges(source.ranges, start, end),
	};
}

function joinSource(parts: readonly MappedText[], document: SourceDocument): MappedText {
	return {
		document,
		text: parts.map((part) => part.text).join(""),
		ranges: concatRanges(parts.map((part) => part.ranges)),
	};
}

/** A parser normalization expressed as explicit consumed spans, never a search for token text. */
function replaceSource(
	source: MappedText,
	pattern: RegExp,
	replacement: (match: RegExpExecArray) => MappedText,
): MappedText {
	const parts: MappedText[] = [];
	let offset = 0;
	for (const match of source.text.matchAll(pattern)) {
		parts.push(sliceSource(source, offset, match.index), replacement(match));
		offset = match.index + match[0].length;
	}
	parts.push(sliceSource(source, offset));
	return joinSource(parts, source.document);
}

function remove(source: MappedText, pattern: RegExp): MappedText {
	return replaceSource(source, pattern, (match) => sliceSource(source, match.index, match.index));
}

function trim(source: MappedText): MappedText {
	return sliceSource(source, source.text.length - source.text.trimStart().length, source.text.trimEnd().length);
}

function normalizedText(token: Token, raw: MappedText): MappedText | undefined {
	switch (token.type) {
		case "paragraph":
		case "text":
		case "html":
		case "latex_literal":
			return sliceSource(raw, 0, token.text.length);
		case "latex_inline":
		case "latex_block": {
			const formula = trim(raw);
			const delimiter = token.type === "latex_block" || formula.text.startsWith("\\") ? 2 : 1;
			return trim(sliceSource(formula, delimiter, -delimiter));
		}
		case "heading": {
			if (/^ {0,3}#{1,6}(?:\s|$)/.test(raw.text)) {
				const prefix = /^ {0,3}#{1,6}(?:\s+|$)/.exec(raw.text)?.[0].length ?? 0;
				return sliceSource(raw, prefix, prefix + token.text.length);
			}
			return trim(remove(raw, /\n {0,3}(?:=+|-+)[ \t]*(?:\n|$)/g));
		}
		case "strong":
		case "em":
		case "del": {
			const size = token.type === "em" ? 1 : 2;
			return sliceSource(raw, size, raw.text.length - size);
		}
		case "escape":
			return sliceSource(raw, 1);
		case "codespan": {
			const size = /^`+/.exec(raw.text)?.[0].length ?? 0;
			let text = sliceSource(raw, size, raw.text.length - size);
			text = replaceSource(text, /\n/g, (match) => ({
				...sliceSource(text, match.index, match.index + 1),
				text: " ",
			}));
			if (/^ .* $/.test(text.text) && /[^ ]/.test(text.text)) text = sliceSource(text, 1, -1);
			return text;
		}
		case "link":
		case "image": {
			const prefix = raw.text.startsWith("![") ? 2 : raw.text.startsWith("[") || raw.text.startsWith("<") ? 1 : 0;
			if (token.type === "link" && token.autolink) {
				return sliceSource(raw, prefix, prefix + token.text.length);
			}
			// Marked unescapes bracket escapes in labels before inline lexing.
			const text = remove(sliceSource(raw, prefix), /\\(?=[[\]])/g);
			return sliceSource(text, 0, token.text.length);
		}
		case "code": {
			if (token.codeBlockStyle === "indented") {
				return sliceSource(remove(raw, /^(?: {0,3}\t| {1,4})/gm), 0, token.text.length);
			}
			const fence = new RegExp(Lexer.rules.block.gfm.fences.source, "d").exec(raw.text);
			if (!fence) return undefined;
			const capture = fence.indices?.[3];
			let text = capture ? sliceSource(raw, capture[0], capture[1]) : sliceSource(raw, 0, 0);
			const indent = /^(\s+)(?:```)/.exec(raw.text)?.[1].length ?? 0;
			if (indent) text = remove(text, new RegExp(`^[^\\S\\n]{1,${indent}}`, "gm"));
			return sliceSource(text, 0, token.text.length);
		}
		default:
			return undefined;
	}
}

function mapTokens(tokens: Token[], input: MappedText): void {
	for (const token of tokens) {
		const location = locations.get(token);
		if (!location || location.frame.text !== input.text) continue;
		locations.delete(token);
		let raw = sliceSource(input, location.start, location.end);
		// Marked removes tight task checkboxes after the block lexer has consumed them.
		const checkbox = /^\[[ xX]\][ \t]+/.exec(raw.text);
		if (checkbox && (token.type === "paragraph" || token.type === "text") && !/^\[[ xX]\]/.test(token.raw)) {
			raw = sliceSource(raw, checkbox[0].length);
		}
		const text = normalizedText(token, raw);
		const validText = text && "text" in token && text.text === token.text ? text : undefined;
		let href: MappedText | undefined;
		if (token.type === "link") {
			const capture = new RegExp(Lexer.rules.inline.gfm.link.source, "d").exec(raw.text)?.indices?.[2];
			if (capture) {
				href = trim(sliceSource(raw, capture[0], capture[1]));
				if (href.text.startsWith("<")) href = sliceSource(href, 1, -1);
				href = remove(href, /\\(?=[!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/g);
				if (href.text !== token.href) href = undefined;
			}
		}
		tokenSources.set(token, { raw, text: validText, href });
		if (token.type === "list") {
			let offset = 0;
			for (const item of token.items) {
				const itemRaw = sliceSource(raw, offset, offset + item.raw.length);
				offset += item.raw.length;
				tokenSources.set(item, { raw: itemRaw });
				const marker = /^( {0,3}(?:[*+-]|\d{1,9}[.)]))( *)([^\n]*)/.exec(itemRaw.text);
				if (!marker) continue;
				const padding = marker[2].length > 4 ? 1 : marker[2].length;
				const indent = marker[1].length + padding;
				let contents = sliceSource(itemRaw, indent);
				contents = remove(contents, new RegExp(`(?<=\\n)(?: {${indent}}| {1,${indent}}(?=\\n|$))`, "g"));
				// The list tokenizer consumes each line's terminator in raw, but appends
				// newlines to itemContents only before the next line.
				if (contents.text.endsWith("\n")) contents = sliceSource(contents, 0, -1);
				// The last item is trimmed by Marked before its child lexer runs.
				if (item === token.items.at(-1)) contents = sliceSource(contents, 0, contents.text.trimEnd().length);
				mapTokens(item.tokens, contents);
			}
		} else if (token.type === "blockquote") {
			const quote = remove(raw, /^ {0,3}>[ \t]?/gm);
			mapTokens(token.tokens ?? [], sliceSource(quote, 0, quote.text.replace(/\n+$/, "").length));
		} else if (token.type === "table") {
			// Cell locations are consumed in source row order, including escaped pipes.
			const rows = [...raw.text.matchAll(/[^\n]+/g)];
			const cells = [token.header, ...token.rows];
			for (let row = 0; row < cells.length; row++) {
				const line = rows[row === 0 ? 0 : row + 1];
				if (!line) continue;
				let start = /^\s*\|/.exec(line[0])?.[0].length ?? 0;
				let cell = 0;
				for (let cursor = start; cursor <= line[0].length; cursor++) {
					if (line[0][cursor] === "\\") {
						cursor++;
						continue;
					}
					if (cursor < line[0].length && line[0][cursor] !== "|") continue;
					const target = cells[row][cell++];
					if (!target) break;
					const mapped = remove(trim(sliceSource(raw, line.index + start, line.index + cursor)), /\\(?=\|)/g);
					mapTokens(target.tokens, mapped);
					start = cursor + 1;
				}
			}
		} else if (validText && "tokens" in token && token.tokens) {
			const childText = token.tokens[0]?.type === "checkbox" ? remove(validText, /^\[[ xX]\][ \t]+/g) : validText;
			mapTokens(token.tokens, childText);
		}
	}
}

export function lexWithSources(text: string, options: MarkedOptions): Token[] {
	const document: SourceDocument = { text, enclosures: [] };
	let source: MappedText = {
		document,
		text,
		ranges: linearRanges(0, text.length),
	};
	source = replaceSource(source, /\t|\r\n|\r/g, (match) => {
		const range = { start: match.index, end: match.index + match[0].length };
		const replacement = match[0] === "\t" ? "   " : "\n";
		return { document, text: replacement, ranges: repeatedRange(range, replacement.length) };
	});
	const tokens = new SourceLexer(options).lex(source.text);
	mapTokens(tokens, source);
	return tokens;
}

export function tokenSource(token: Token): { raw: MappedText; text?: MappedText; href?: MappedText } | undefined {
	return tokenSources.get(token);
}
