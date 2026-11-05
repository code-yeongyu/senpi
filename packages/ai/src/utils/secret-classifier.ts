// What the credential redactor recognizes (senpi#4283): the credential words a name ends with, and the shapes of known
// key prefixes and JWTs. Each check reads only the characters of the token it is given, forward, without a regular
// expression.

import { isAlnum, isBase64Url, isDigit, isLower, isNameChar, isUpper, matchesAt, readUnit } from "./secret-lexer.ts";

/** The last component of a credential name, after digits and qualifiers are stripped (see secretWord). */
const SECRET_WORDS = new Set([
	"key",
	"apikey",
	"accesskey",
	"secretkey",
	"privatekey",
	"token",
	"accesstoken",
	"refreshtoken",
	"authtoken",
	"apitoken",
	"idtoken",
	"secret",
	"clientsecret",
	"auth",
	"authorization",
	"bearer",
	"cookie",
	"cookies",
	"password",
	"passwd",
	"pwd",
	"passphrase",
	"credential",
	"credentials",
	"signature",
	"sig",
]);
/** Names whose whole value is a credential at any length; every other credential name needs a 16-character value. */
export const STRICT_WORDS = new Set([
	"password",
	"passwd",
	"pwd",
	"passphrase",
	"secret",
	"clientsecret",
	"authorization",
	"bearer",
]);
export const COOKIE_WORDS = new Set(["cookie", "cookies"]);
/** A trailing component that names a part of the credential the name before it holds: api_key_value, apiKeyId. */
const QUALIFIERS = new Set(["value", "val", "id"]);
export const SCHEMES = new Set(["bearer", "basic", "token", "apikey"]);
/** Values that are never credentials, including a replacement an earlier pass wrote (redaction is idempotent). */
const INERT_VALUES = new Set(["redacted", "null", "true", "false", "none", "undefined"]);
export const COOKIE_ATTRIBUTES = new Set([
	"path",
	"domain",
	"expires",
	"max-age",
	"samesite",
	"secure",
	"httponly",
	"priority",
	"partitioned",
]);

const isUpperOrDigit = (c: number): boolean => isDigit(c) || isUpper(c);
const isSlackChar = (c: number): boolean => isAlnum(c) || c === 45;
const isPatChar = (c: number): boolean => isAlnum(c) || c === 95;
const isWordChar = (c: number): boolean => isAlnum(c) || c === 95;

/** Split a name into lowercase components on "_", "-", "." and camelCase, reading only the name's own characters. */
function nameComponents(text: string, start: number, end: number): string[] {
	const parts: string[] = [];
	let current = "";
	for (let i = start; i < end; i++) {
		const c = text.charCodeAt(i);
		if (c === 95 || c === 45 || c === 46) {
			if (current.length > 0) parts.push(current);
			current = "";
			continue;
		}
		if (isUpper(c) && current.length > 0) {
			const previous = text.charCodeAt(i - 1);
			const next = i + 1 < end ? text.charCodeAt(i + 1) : 0;
			if (isLower(previous) || isDigit(previous) || (isUpper(previous) && isLower(next))) {
				parts.push(current);
				current = "";
			}
		}
		current += String.fromCharCode(isUpper(c) ? c + 32 : c);
	}
	if (current.length > 0) parts.push(current);
	return parts;
}

function isAllDigits(part: string): boolean {
	for (let k = 0; k < part.length; k++) if (!isDigit(part.charCodeAt(k))) return false;
	return true;
}

function withoutTrailingDigits(part: string): string {
	let end = part.length;
	while (end > 1 && isDigit(part.charCodeAt(end - 1))) end--;
	return part.slice(0, end);
}

/**
 * The credential word a name ends with, after its normalization: numbered slots (OPENAI_API_KEY_2, token2,
 * x-api-key-1) and a trailing qualifier (api_key_value, apiKeyId) still end with the word. "session" counts only as
 * the whole name, so session_id stays readable; a word elsewhere in a name (token_type, primary_key_column) or inside
 * a word (monkey, tokenizer, max_tokens) does not count.
 */
export function secretWord(text: string, start: number, end: number): string | undefined {
	const parts = nameComponents(text, start, end);
	if (parts.length === 1 && parts[0] === "session") return "session";
	let last = parts.length - 1;
	for (;;) {
		while (last >= 0 && isAllDigits(parts[last] ?? "")) last--;
		if (last > 0 && QUALIFIERS.has(parts[last] ?? "")) last--;
		else break;
	}
	if (last < 0) return undefined;
	const word = withoutTrailingDigits(parts[last] ?? "");
	return SECRET_WORDS.has(word) ? word : undefined;
}

/** Where the name ends a token: its last run of name characters (a URL path or escape before it is not the name). */
export function nameStart(text: string, start: number, end: number): number {
	let i = end;
	while (i > start && isNameChar(text.charCodeAt(i - 1))) i--;
	return i;
}

export function lowerToken(text: string, start: number, end: number, maxLength: number): string | undefined {
	return end - start > maxLength ? undefined : text.slice(start, end).toLowerCase();
}

export function isInert(text: string, start: number, end: number): boolean {
	const word = lowerToken(text, start, end, 9);
	return word !== undefined && INERT_VALUES.has(word);
}

interface PrefixRule {
	readonly prefixes: readonly string[];
	readonly min: number;
	readonly chars: (c: number) => boolean;
	/** The run after the prefix is exactly min characters long (AWS access key ids). */
	readonly exact?: boolean;
}

/** Credential-shaped tokens recognized by their prefix wherever a word starts with it. */
const PREFIX_RULES: readonly PrefixRule[] = [
	{ prefixes: ["sk-"], min: 8, chars: isBase64Url },
	{ prefixes: ["sk_live_", "sk_test_", "rk_live_", "rk_test_"], min: 16, chars: isAlnum },
	{ prefixes: ["gsk_", "xai-", "hf_"], min: 20, chars: isAlnum },
	{ prefixes: ["xoxa-", "xoxb-", "xoxo-", "xoxp-", "xoxr-", "xoxs-"], min: 10, chars: isSlackChar },
	{ prefixes: ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"], min: 20, chars: isAlnum },
	{ prefixes: ["github_pat_"], min: 20, chars: isPatChar },
	{ prefixes: ["AKIA", "ASIA"], min: 16, chars: isUpperOrDigit, exact: true },
	{ prefixes: ["AIza"], min: 30, chars: isBase64Url },
];

/** Bounded work: the prefix plus at most min + 1 characters after it. */
function matchesPrefixRule(text: string, start: number, end: number, rule: PrefixRule): boolean {
	for (const prefix of rule.prefixes) {
		if (!matchesAt(text, start, prefix, end)) continue;
		let run = 0;
		const limit = rule.exact === true ? rule.min + 1 : rule.min;
		for (let i = start + prefix.length; i < end && run < limit && rule.chars(text.charCodeAt(i)); i++) run++;
		return rule.exact === true ? run === rule.min : run >= rule.min;
	}
	return false;
}

/** A known key ends at its alphabet's boundary, not at the end of a URL or filename containing it. */
export function credentialShapeEnd(text: string, start: number, end: number): number {
	for (const rule of PREFIX_RULES) {
		if (!matchesPrefixRule(text, start, end, rule)) continue;
		for (const prefix of rule.prefixes) {
			if (!matchesAt(text, start, prefix, end)) continue;
			let i = start + prefix.length;
			while (i < end) {
				const unit = readUnit(text, i);
				if (!rule.chars(unit.character)) break;
				i += unit.length;
			}
			return i;
		}
	}
	// JWTs have their own segment grammar; retain the conservative span for those.
	return end;
}

/**
 * Whether a JWT (three base64url segments joined by ".", the first a JSON header "eyJ") starts at p: -1 when one does,
 * else where the next JWT candidate may start. A candidate before the first "." after p sees the same segments with a
 * shorter first one, so it cannot match either; skipping to that "." caps every walk at three segments, and each
 * segment is walked by at most three candidates.
 */
function jwtAt(text: string, p: number, end: number): number {
	if (!matchesAt(text, p, "eyJ", end)) return p + 1;
	let segments = 1;
	let length = 0;
	let firstDot = -1;
	let i = p;
	for (; i < end;) {
		const unit = readUnit(text, i);
		const c = unit.character;
		if (c === 46) {
			if (firstDot < 0) firstDot = i;
			const next = i + unit.length < end ? readUnit(text, i + unit.length).character : 0;
			if (segments === 3) return length >= 5 && !isBase64Url(next) ? -1 : firstDot;
			if (length < (segments === 1 ? 8 : 5)) return firstDot;
			segments++;
			length = 0;
		} else if (isBase64Url(c)) length++;
		else break;
		i += unit.length;
	}
	if (segments === 3 && length >= 5) return -1;
	return firstDot >= 0 ? firstDot : i;
}

/**
 * Where the first credential-shaped run in [start, end) begins, or -1: a known key prefix or a JWT at the start of a
 * word anywhere in the token (after "/", "+", "~", "-", "." or "%", so URL userinfo, paths and joined values count),
 * including percent-encoded token punctuation, never inside a word ("tasks-..." is not "sk-...").
 * After a credential has already been found, withinCredential also checks inside words: an adjoining key may have
 * had its prefix consumed by the first key's alphabet. The caller retains the whole token in that ambiguous case.
 * Constant work per character plus the JWT walks bounded above.
 */
export function credentialShapeStart(text: string, start: number, end: number, withinCredential = false): number {
	let stop = end;
	while (stop > start && text.charCodeAt(stop - 1) === 46) stop--;
	let jwtFrom = start;
	let wordStart = true;
	for (let p = start; p < stop;) {
		const unit = readUnit(text, p);
		const candidate = withinCredential || wordStart;
		wordStart = !isWordChar(unit.character);
		const position = p;
		p += unit.length;
		if (!candidate) continue;
		for (const rule of PREFIX_RULES) if (matchesPrefixRule(text, position, stop, rule)) return position;
		if (position < jwtFrom) continue;
		const next = jwtAt(text, position, stop);
		if (next < 0) return position;
		jwtFrom = next;
	}
	return -1;
}
