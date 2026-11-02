/**
 * Generic secret detection for `/share` (#3524): values that match no known
 * provider shape but look machine-generated. Lowercase hex (commit ids,
 * digests), UUIDs and ULIDs never qualify, identifiers and slash lists that read
 * as words are spared, and SRI integrity hashes stay. A token broken across a
 * line, an escaped newline, a backslash continuation or a string-literal seam is
 * judged as one value.
 */

const RUN_CHAR = "[A-Za-z0-9+/_-]";
const PAD = "={0,2}";
/** Every way a value gets broken in a transcript: a newline, `\n` escaped inside JSON, a `\` continuation, `" + "` or `", "`. */
const GAP = String.raw`(?:\\?\r?\n[ \t]*|(?:\\r)?\\n[ \t]*|["'][ \t]*[+,]?[ \t]*(?:\r?\n[ \t]*)?["'])`;
const SINGLE_RUN = new RegExp(`(?<!${RUN_CHAR})${RUN_CHAR}{20,}${PAD}(?![A-Za-z0-9+/=_-])`, "g");
const SPLIT_RUN = new RegExp(
	`(?<!${RUN_CHAR})(${RUN_CHAR}{8,})(${GAP})(${RUN_CHAR}{8,}${PAD})(?![A-Za-z0-9+/=_-])`,
	"g",
);
const WRAPPED_TAIL = new RegExp(`(<redacted>)(${GAP})(${RUN_CHAR}{6,}${PAD})(?![A-Za-z0-9+/=_-])`, "g");
const INTEGRITY_PREFIX = /sha(?:256|384|512)-$/;
const INTEGRITY_RUN = /^sha(?:256|384|512)-/;

export function shannonBitsPerChar(text: string): number {
	const counts = new Map<string, number>();
	for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
	let bits = 0;
	for (const n of counts.values()) bits -= (n / text.length) * Math.log2(n / text.length);
	return bits;
}

const WORD_PIECE = /[A-Z]?[a-z]{3,}|[0-9]+/g;
/** Case-run pieces: words average 3+ characters, random base62 splits into pieces of about two. */
const CASE_PIECE = /[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]+/g;

function pronounceable(piece: string): boolean {
	if (/^[0-9]+$/.test(piece)) return piece.length <= 3;
	return /[aeiouy]/i.test(piece) && !/[^aeiouy]{4,}/i.test(piece);
}

/**
 * Identifiers are made of words: most of the run is long pronounceable lowercase
 * pieces (random base62 almost never has runs of 3+ lowercase letters) and the
 * letters carry English vowel density (random letters run at about 19%).
 */
export function readsAsWords(run: string, coverage = 0.6): boolean {
	const letters = run.replace(/[^A-Za-z]/g, "");
	const vowels = letters.replace(/[^aeiouAEIOU]/g, "").length;
	if (letters.length === 0 || vowels / letters.length < 0.3) return false;
	const covered = [...run.matchAll(WORD_PIECE)]
		.map((match) => match[0])
		.filter(pronounceable)
		.reduce((sum, piece) => sum + piece.length, 0);
	const pieces = run.match(CASE_PIECE) ?? [];
	return covered >= run.length * coverage && pieces.length > 0 && run.length / pieces.length >= 3;
}

/** A path or a slash list (`a/b/c.ts`, `1/true/yes`, `VISUAL/EDITOR`): every segment is a word, a constant or lowercase. */
function readsAsPath(run: string): boolean {
	const segments = run.split("/").filter((segment) => segment.length > 0);
	return segments.length >= 2 && segments.every(isPlainSegment);
}

function isPlainSegment(segment: string): boolean {
	return /^[a-z0-9._@-]+$/.test(segment) || /^[A-Z0-9_]+$/.test(segment) || readsAsWords(segment);
}

/** Mixed case, high per-character entropy for its length, and not words or a path. */
export function looksGenerated(run: string): boolean {
	const body = run.replace(/=+$/, "");
	if (body.length < 16) return false;
	const upper = body.replace(/[^A-Z]/g, "").length;
	const lower = body.replace(/[^a-z]/g, "").length;
	const digits = body.replace(/[^0-9]/g, "").length;
	const symbols = body.replace(/[^+/]/g, "").length;
	const classes = [upper, lower, digits, symbols].filter((n) => n > 0).length;
	if (lower < 2 || (upper < 2 && classes < 3)) return false;
	if (shannonBitsPerChar(body) < Math.min(3.8, Math.log2(body.length) - 1.2)) return false;
	return !readsAsWords(body) && !readsAsPath(body);
}

/** A split is joined only when neither half is ordinary text on its own (a word, a constant name, a slash list). */
function plainHalf(half: string): boolean {
	return /^[a-z0-9._@-]+$/.test(half) || /^[A-Z0-9_]+$/.test(half) || readsAsPath(half) || readsAsWords(half, 0.85);
}

function integrityAt(run: string, offset: number, whole: string): boolean {
	return INTEGRITY_RUN.test(run) || INTEGRITY_PREFIX.test(whole.slice(Math.max(0, offset - 7), offset));
}

/** Whether `head + tail`, joined across a gap, is one generated value. Shared by text and structured redaction. */
export function joinedLooksGenerated(head: string, tail: string): boolean {
	return !plainHalf(head) && !plainHalf(tail) && looksGenerated(head + tail);
}

export function redactGeneratedValues(text: string, onRedact: () => void): string {
	let result = text.replace(
		SPLIT_RUN,
		(match, head: string, gap: string, tail: string, offset: number, whole: string) => {
			if (integrityAt(head, offset, whole) || !joinedLooksGenerated(head, tail)) return match;
			onRedact();
			return `<redacted>${gap}<redacted>`;
		},
	);
	result = result.replace(SINGLE_RUN, (run: string, offset: number, whole: string) => {
		if (integrityAt(run, offset, whole)) return run;
		if (run.length < 32 && !/[+/]|=$/.test(run)) return run;
		if (!looksGenerated(run)) return run;
		onRedact();
		return "<redacted>";
	});
	return result.replace(WRAPPED_TAIL, (match, redacted: string, gap: string, tail: string) => {
		const mixed = /[A-Za-z]/.test(tail) && (/[0-9]/.test(tail) || (/[A-Z]/.test(tail) && /[a-z]/.test(tail)));
		if (!mixed || /^[a-z0-9._@-]+$/.test(tail) || /^[A-Z0-9_]+$/.test(tail) || readsAsPath(tail)) return match;
		onRedact();
		return `${redacted}${gap}<redacted>`;
	});
}

const EDGE_START = new RegExp(`^(${RUN_CHAR}{8,}${PAD})`);
const EDGE_END = new RegExp(`(?<!${RUN_CHAR})(${RUN_CHAR}{8,})$`);

/** Two adjacent strings (text blocks, array items) whose touching ends form one generated value lose both ends. */
export function redactAcrossBoundary(left: string, right: string, onRedact: () => void): readonly [string, string] {
	const end = EDGE_END.exec(left)?.[1];
	const start = EDGE_START.exec(right)?.[1];
	if (end === undefined || start === undefined || !joinedLooksGenerated(end, start)) return [left, right];
	onRedact();
	return [`${left.slice(0, -end.length)}<redacted>`, `<redacted>${right.slice(start.length)}`];
}
