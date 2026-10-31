// Credential redaction for provider and gateway text, read token by token in one pass (senpi#4283).
//
// The text is read ONCE, left to right, as alternating runs: a token (value characters) and a delimiter (everything
// between two tokens), see secret-lexer.ts. A token is classified only from its own characters and the delimiters on
// either side of it (secret-classifier.ts); nothing inside the loop searches, slices from the start or re-reads earlier
// text, so the work is linear in the input whatever its shape. The scanner uses no regular expressions. A replaced
// range is a whole token (plus the base64 padding after it), the rest of a token from where a credential shape starts,
// the whole value of a strict name (to its closing quote, or to the end of a bare value; the scan continues after it),
// or a URL userinfo password, from its ":" to the "@".

import {
	COOKIE_ATTRIBUTES,
	COOKIE_WORDS,
	credentialShapeEnd,
	credentialShapeStart,
	isInert,
	lowerToken,
	nameStart,
	SCHEMES,
	STRICT_WORDS,
	secretWord,
} from "./secret-classifier.ts";
import {
	bareValueEnd,
	emptyDelimiter,
	quotedValueEnd,
	readDelimiter,
	readUnit,
	tokenUnitLength,
} from "./secret-lexer.ts";

const MIN_SECRET_LENGTH = 16;
const MIN_BEARER_LENGTH = 8;
const OBJECT_SPAN = 4096;
const MAX_COOKIE_PAIRS = 64;
const MAX_USERINFO_LENGTH = 256;

/** Append [start, end) to the sorted, disjoint ranges, merging what it overlaps. */
function addRange(ranges: number[], start: number, end: number): void {
	let stop = end;
	while (ranges.length > 0 && (ranges[ranges.length - 2] ?? 0) >= start) {
		stop = Math.max(stop, ranges[ranges.length - 1] ?? 0);
		ranges.length -= 2;
	}
	if (ranges.length > 0 && (ranges[ranges.length - 1] ?? 0) >= start) {
		ranges[ranges.length - 1] = Math.max(ranges[ranges.length - 1] ?? 0, stop);
	} else ranges.push(start, stop);
}

type Mode = "none" | "scheme" | "value" | "cookie" | "cookie-value" | "object";

/** The [start, end) ranges of every credential in text, found in one left-to-right pass. */
function secretRanges(text: string, shapesOnly = false): number[] {
	const ranges: number[] = [];
	let before = emptyDelimiter();
	let after = emptyDelimiter();
	readDelimiter(text, 0, before);
	if (before.refusalStart >= 0) return [before.refusalStart, text.length];
	let i = before.end;
	let mode: Mode = "none";
	let strict = false;
	let quote = -1;
	let quoteDepth = 0;
	let cookiePairs = 0;
	let cookieAttribute = false;
	let objectDepth = 0;
	let objectEnd = 0;
	let bearerArmed = false;
	let userinfoStart = -1;
	while (i < text.length) {
		const start = i;
		let slashes = 0;
		while (i < text.length) {
			const length = tokenUnitLength(text, i);
			if (length === 0) break;
			if (readUnit(text, i).character === 47) slashes++;
			i += length;
		}
		const end = i;
		readDelimiter(text, end, after);
		i = after.end;
		const valueEnd = after.paddingEnd;
		const valueLength = valueEnd - start;
		if (after.refusalStart >= 0) {
			// Do not let a bounded decoder refusal expose either an earlier shape or an unknown named value.
			addRange(ranges, start, text.length);
			break;
		}

		if (!shapesOnly && userinfoStart >= 0) {
			if (slashes > 0 || end - userinfoStart > MAX_USERINFO_LENGTH) userinfoStart = -1;
			else if (after.at >= 0) {
				if (after.at > userinfoStart) addRange(ranges, userinfoStart, after.at);
				userinfoStart = -1;
			} else if (after.endsUserinfo) userinfoStart = -1;
		}
		const first = readUnit(text, start);
		const authority =
			slashes === 2 && first.character === 47 && readUnit(text, start + first.length).character === 47;
		if (!shapesOnly && authority && before.colonOnly && after.colonOnly) userinfoStart = after.end;

		const shape = credentialShapeStart(text, start, end);
		if (shape >= 0) {
			// A second prefix can begin inside the first alphabet, not just after its end. Keep the old conservative
			// token span for joined credentials; only an unambiguous single key releases its filename suffix.
			const joined = credentialShapeStart(text, shape + readUnit(text, shape).length, end, true);
			const stop = joined >= 0 ? end : credentialShapeEnd(text, shape, end);
			addRange(ranges, shape, stop);
		}
		if (shapesOnly) continue;
		if (bearerArmed && valueLength >= MIN_BEARER_LENGTH && !isInert(text, start, end)) {
			addRange(ranges, start, valueEnd);
		}
		bearerArmed = after.spaceOnly && lowerToken(text, start, end, 6) === "bearer";

		const idle = mode === "none";
		if (mode === "scheme" && SCHEMES.has(lowerToken(text, start, end, 6) ?? "")) {
			// An auth scheme is never the value itself: the token after it is, or there is none ("Bearer [REDACTED]").
			mode = after.spaceOnly ? "value" : "none";
		} else if ((mode === "scheme" || mode === "value") && strict) {
			if (!isInert(text, start, end)) {
				// The whole value of a strict name, read forward to where the field ends; the scan resumes there.
				const stop = quote >= 0 ? quotedValueEnd(text, end, quote, quoteDepth) : bareValueEnd(text, end);
				addRange(ranges, start, Math.max(stop, valueEnd));
				if (stop > end) {
					readDelimiter(text, stop, after);
					i = after.end;
					bearerArmed = false;
				}
			}
			mode = "none";
		} else if (mode === "scheme" || mode === "value") {
			if (valueLength >= MIN_SECRET_LENGTH && !isInert(text, start, end)) addRange(ranges, start, valueEnd);
			mode = "none";
		} else if (mode === "cookie") {
			if (after.pairEquals) {
				cookieAttribute = COOKIE_ATTRIBUTES.has(lowerToken(text, start, end, 11) ?? "");
				mode = "cookie-value";
			} else {
				if (valueLength >= MIN_SECRET_LENGTH && !isInert(text, start, end)) addRange(ranges, start, valueEnd);
				mode = after.cookieGap && ++cookiePairs < MAX_COOKIE_PAIRS ? "cookie" : "none";
			}
		} else if (mode === "cookie-value") {
			if (!cookieAttribute && !isInert(text, start, end)) addRange(ranges, start, valueEnd);
			mode = after.cookieGap && ++cookiePairs < MAX_COOKIE_PAIRS ? "cookie" : "none";
		} else if (mode === "object") {
			const value = before.separator && !before.opensObject;
			if (value && valueLength >= MIN_SECRET_LENGTH && !isInert(text, start, end)) addRange(ranges, start, valueEnd);
			objectDepth += after.braceDepth;
			if (objectDepth <= 0 || end > objectEnd) mode = "none";
		}

		if (idle && (after.separator || (before.endsWithLt && after.closesTag))) {
			const word = secretWord(text, nameStart(text, start, end), end);
			if (word !== undefined && COOKIE_WORDS.has(word)) {
				mode = "cookie";
				cookiePairs = 0;
			} else if (word !== undefined && after.opensObject) {
				mode = "object";
				objectDepth = after.braceDepth;
				objectEnd = end + OBJECT_SPAN;
			} else if (word !== undefined) {
				mode = "scheme";
				strict = STRICT_WORDS.has(word);
				quote = after.quote;
				quoteDepth = after.quoteBackslashes;
			}
		}
		const previous = before;
		before = after;
		after = previous;
	}
	return ranges;
}

function replaceRanges(text: string, ranges: readonly number[], replacement: string): string {
	if (ranges.length === 0) return text;
	const out: string[] = [];
	let copied = 0;
	for (let k = 0; k < ranges.length; k += 2) {
		out.push(text.slice(copied, ranges[k]), replacement);
		copied = ranges[k + 1] ?? copied;
	}
	out.push(text.slice(copied));
	return out.join("");
}

/**
 * Mask credentials in provider or gateway text by value, not by a list of names: the value after a name that ends
 * with a credential word (in a header, JSON, array, Go map, Python repr, XML, URL query, form body, cookie or
 * environment assignment, with ASCII, typographic or HTML-escaped quotes, at any escaping depth; 16 characters or
 * more, or the whole value at any length under a password, secret, authorization or bearer name), every cookie value,
 * every long value of an object held under such a name, URL userinfo passwords, bearer tokens, and known key prefixes
 * and JWTs wherever a word starts with one (inside URLs, userinfo and paths too). Model ids, error codes, request ids
 * and names that merely contain a credential word stay readable. One linear pass, no regular expressions.
 */
export function redactSecrets(text: string, replacement = "[REDACTED]"): string {
	return replaceRanges(text, secretRanges(text), replacement);
}

/** Mask only credential-shaped runs (known key prefixes and JWTs), whatever surrounds them. One linear pass. */
export function redactCredentialShapes(text: string, replacement = "[REDACTED]"): string {
	return replaceRanges(text, secretRanges(text, true), replacement);
}
