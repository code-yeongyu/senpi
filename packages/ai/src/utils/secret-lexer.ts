// The lexical layer of the credential redactor (senpi#4283): character classes, percent escapes and HTML entities read
// as what they encode, the token and delimiter units the one-pass scanner alternates between, and the forward scans
// that find where a quoted or bare value ends. Every function reads forward from the index it is given; none searches
// back or uses a regular expression.

const HTML_ENTITIES: readonly (readonly [entity: string, character: number])[] = [
	["&quot;", 34],
	["&#34;", 34],
	["&#034;", 34],
	["&#x22;", 34],
	["&#39;", 39],
	["&#039;", 39],
	["&#x27;", 39],
	["&lt;", 60],
	["&gt;", 62],
	["&amp;", 38],
];

const MAX_SEPARATOR_LENGTH = 32;
const MAX_SCHEME_GAP = 8;
const PERCENT_WINDOW = 64;

interface Unit {
	character: number;
	length: number;
	refusal?: "percent-window";
}

export const isDigit = (c: number): boolean => c >= 48 && c <= 57;
export const isUpper = (c: number): boolean => c >= 65 && c <= 90;
export const isLower = (c: number): boolean => c >= 97 && c <= 122;
export const isAlnum = (c: number): boolean => isDigit(c) || isUpper(c) || isLower(c);
export const isBase64Url = (c: number): boolean => isAlnum(c) || c === 95 || c === 45;
export const isNameChar = (c: number): boolean => isBase64Url(c) || c === 46;
const isTokenChar = (c: number): boolean => isNameChar(c) || c === 43 || c === 47 || c === 126;
const isSpace = (c: number): boolean => c === 32 || c === 9 || c === 10 || c === 13;
const isQuote = (c: number): boolean => c === 34 || c === 39 || c === 96 || c === 92;
const isOpeningQuote = (c: number): boolean => c === 34 || c === 39 || c === 96;
const isTypographicQuote = (c: number): boolean => c === 0x201c || c === 0x201d || c === 0x2018 || c === 0x2019;

function hexValue(c: number): number {
	if (isDigit(c)) return c - 48;
	if (c >= 65 && c <= 70) return c - 55;
	if (c >= 97 && c <= 102) return c - 87;
	return -1;
}

export function matchesAt(text: string, i: number, literal: string, limit = text.length): boolean {
	if (i + literal.length > limit) return false;
	for (let k = 0; k < literal.length; k++) if (text.charCodeAt(i + k) !== literal.charCodeAt(k)) return false;
	return true;
}

/** The length of the token unit at i (a value character, or a percent escape of one), or 0 at a delimiter. */
export function tokenUnitLength(text: string, i: number): number {
	const c = text.charCodeAt(i);
	if (isTokenChar(c)) return 1;
	if (c !== 37) return 0;
	const unit = readUnit(text, i);
	if (unit.refusal !== undefined) return 0;
	return isTokenChar(unit.character) || unit.length === 1 ? unit.length : 0;
}

/**
 * Repeated full-window percent decoding to a fixpoint, keeping each character's original source end.
 * A pass shrinks the 64-character window by at least two, so both work and storage here are bounded.
 * Malformed escapes are literal, but an unfinished escape at the window edge is not a proven boundary.
 */
function percentWindow(text: string, start: number, prefixEnd: number): Unit {
	const limit = Math.min(text.length, prefixEnd + PERCENT_WINDOW - 1);
	let needsDecoding = false;
	let contiguous = true;
	let previous = 37;
	for (let p = prefixEnd; p < limit; p++) {
		const c = text.charCodeAt(p);
		const hex = hexValue(c) >= 0;
		if (previous === 37 && hex) {
			needsDecoding = true;
			break;
		}
		if (c !== 37 && !hex) contiguous = false;
		previous = c;
	}
	// Without a possible escape no pass can change the window, so do not allocate its fixpoint buffers.
	if (!needsDecoding) {
		if (contiguous && limit < text.length) return { character: 37, length: limit - start, refusal: "percent-window" };
		return { character: 37, length: prefixEnd - start };
	}
	const characters = [37];
	const ends = [prefixEnd];
	for (let p = prefixEnd; p < limit; p++) {
		characters.push(text.charCodeAt(p));
		ends.push(p + 1);
	}
	let changed: boolean;
	do {
		changed = false;
		let written = 0;
		for (let p = 0; p < characters.length; p++) {
			let c = characters[p] ?? 0;
			const high = hexValue(characters[p + 1] ?? -1);
			const low = hexValue(characters[p + 2] ?? -1);
			if (c === 37 && high >= 0 && low >= 0) {
				c = high * 16 + low;
				p += 2;
				changed = true;
			}
			characters[written] = c;
			ends[written++] = ends[p] ?? prefixEnd;
		}
		characters.length = written;
		ends.length = written;
	} while (changed);

	const character = characters[0] ?? 37;
	if (character === 37 && limit < text.length) {
		// Only a contiguous percent/hex run can depend on text beyond the window. A non-hex literal
		// breaks the dependency: the percent before it can never decode on any later pass.
		for (let p = 1; p < characters.length; p++) {
			const c = characters[p] ?? 0;
			if (c !== 37 && hexValue(c) < 0) return { character, length: (ends[0] ?? prefixEnd) - start };
		}
		return { character, length: limit - start, refusal: "percent-window" };
	}
	return { character, length: (ends[0] ?? prefixEnd) - start };
}

/** One logical character and its full source width, shared by token, delimiter and word-boundary scans. */
export function readUnit(text: string, i: number): Unit {
	const c = text.charCodeAt(i);
	if (c === 37) {
		let end = i + 1;
		let decoded = c;
		// Collapse literal %25 layers in one forward walk before the bounded full-window decoder.
		// This is the fixpoint of that prefix, not a depth cap: even million-layer canonical chains stay linear.
		while (end + 1 < text.length) {
			const high = hexValue(text.charCodeAt(end));
			const low = hexValue(text.charCodeAt(end + 1));
			if (high < 0 || low < 0) break;
			decoded = high * 16 + low;
			end += 2;
			if (decoded !== 37) return { character: decoded, length: end - i };
		}
		return percentWindow(text, i, end);
	}
	if (c === 38) {
		for (const [entity, character] of HTML_ENTITIES) {
			if (matchesAt(text, i, entity)) return { character, length: entity.length };
		}
	}
	if (c === 0xff1a) return { character: 58, length: 1 };
	if (c === 0x201c || c === 0x201d) return { character: 34, length: 1 };
	if (c === 0x2018 || c === 0x2019) return { character: 39, length: 1 };
	return { character: c, length: 1 };
}

export interface Delimiter {
	end: number;
	/** The first unresolved percent window; callers conservatively redact from here to the end. */
	refusalStart: number;
	/** One ":" or "=" between quotes, escapes and spaces, then an optional "[" or "{". */
	separator: boolean;
	opensObject: boolean;
	braceDepth: number;
	/** The end of the "=" padding it starts with, which belongs to the token before it. */
	paddingEnd: number;
	pairEquals: boolean;
	cookieGap: boolean;
	spaceOnly: boolean;
	endsWithLt: boolean;
	closesTag: boolean;
	colonOnly: boolean;
	at: number;
	endsUserinfo: boolean;
	/** The quote character the delimiter ends with (it opens the value after it), or -1. */
	quote: number;
	/** How many backslashes escape that quote: the escaping depth its closing quote is written at. */
	quoteBackslashes: number;
}

export function emptyDelimiter(): Delimiter {
	return {
		end: 0,
		refusalStart: -1,
		separator: false,
		opensObject: false,
		braceDepth: 0,
		paddingEnd: 0,
		pairEquals: false,
		cookieGap: false,
		spaceOnly: false,
		endsWithLt: false,
		closesTag: false,
		colonOnly: false,
		at: -1,
		endsUserinfo: false,
		quote: -1,
		quoteBackslashes: 0,
	};
}

/** Read the delimiter that starts at i into d, one unit at a time. */
export function readDelimiter(text: string, i: number, d: Delimiter): void {
	let position = i;
	let units = 0;
	let separators = 0;
	let separatorShape = true;
	let gapMarks = 0;
	let gapShape = true;
	let padding = true;
	let spaces = 0;
	let backslashes = 0;
	let last = -1;
	let first = -1;
	let tagShape = true;
	d.opensObject = false;
	d.braceDepth = 0;
	d.paddingEnd = i;
	d.at = -1;
	d.endsUserinfo = false;
	d.quote = -1;
	d.quoteBackslashes = 0;
	d.refusalStart = -1;
	while (position < text.length && tokenUnitLength(text, position) === 0) {
		const unit = readUnit(text, position);
		if (unit.refusal !== undefined) {
			d.refusalStart = position;
			position = text.length;
			break;
		}
		const c = unit.character;
		if (units === 0) first = c;
		else if (!isSpace(c)) tagShape = false;
		if (padding && c === 61) d.paddingEnd = position + unit.length;
		else {
			padding = false;
			if (c === 59 || c === 44) gapMarks++;
			else if (!isSpace(c) && !isQuote(c)) gapShape = false;
		}
		if (c === 58 || c === 61) separators++;
		else if (c === 123) {
			d.braceDepth++;
			if (separators === 1) d.opensObject = true;
			else separatorShape = false;
		} else if (c === 125) {
			d.braceDepth--;
			separatorShape = false;
		} else if (!isSpace(c) && !isQuote(c) && !(c === 91 && separators === 1)) separatorShape = false;
		if (isSpace(c)) spaces++;
		if (c === 64 && d.at < 0) d.at = position;
		if (isSpace(c) || c === 63 || c === 35) d.endsUserinfo = true;
		d.quote = isOpeningQuote(c) ? c : -1;
		d.quoteBackslashes = backslashes;
		backslashes = c === 92 ? backslashes + 1 : 0;
		last = c;
		units++;
		position += unit.length;
	}
	d.end = position;
	d.separator = separators === 1 && separatorShape && units <= MAX_SEPARATOR_LENGTH;
	d.pairEquals = units === 1 && first === 61;
	d.cookieGap = gapMarks === 1 && gapShape && units <= MAX_SEPARATOR_LENGTH;
	d.spaceOnly = units > 0 && spaces === units && units <= MAX_SCHEME_GAP;
	d.endsWithLt = last === 60;
	d.closesTag = first === 62 && tagShape;
	d.colonOnly = units === 1 && first === 58;
}

/**
 * Where a quoted value that continues at i ends: its closing quote, written at the opening quote's escaping depth (a
 * quote behind more backslashes is escaped inside the value), or the end of the line.
 */
export function quotedValueEnd(text: string, i: number, quote: number, depth: number): number {
	let position = i;
	let backslashes = 0;
	while (position < text.length) {
		const raw = text.charCodeAt(position);
		if (raw === 10 || raw === 13) return position;
		if (raw === 92) {
			backslashes++;
			position++;
			continue;
		}
		const unit = readUnit(text, position);
		if (unit.refusal !== undefined) return text.length;
		if (unit.character === quote && backslashes <= depth) return position - backslashes;
		backslashes = 0;
		position += unit.length;
	}
	return position;
}

/** Where a bare value that continues at i ends: whitespace, ",", ";", "&", a quote or "<" (a closing tag). */
export function bareValueEnd(text: string, i: number): number {
	let position = i;
	for (; position < text.length; position++) {
		const c = text.charCodeAt(position);
		if (isSpace(c) || isQuote(c) || isTypographicQuote(c) || c === 44 || c === 59 || c === 38 || c === 60) break;
	}
	return position;
}
