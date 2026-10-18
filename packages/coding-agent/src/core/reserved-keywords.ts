/**
 * OmO's reserved prompt keywords (`ulw`, `mass ulw`, `ulw plan`, `ulw loop`, `ulw research`).
 *
 * Mirrors the omo-senpi engine's arming rules (omo `packages/omo-senpi/src/components/
 * {ultrawork/index.ts, skill-pointers/index.ts, skill-pointers/strip-quoted-regions.ts}`),
 * so the editor paints a keyword only where the engine would arm it: case-insensitive,
 * spaces or hyphens between words, the mass aliases (`mulw`, `meth`, `ulw mass`), and
 * each name only as a word of its own (not inside an identifier, path, file name or URL).
 * Overlapping mentions all match ("ulw research" is both `ultrawork` and `ulw-research`).
 * Injected blocks, fenced/inline code, relay headers, block quotes, double quotes, URLs
 * and negated invocations ("do not load mass-ulw") are quoted material, never a request.
 */
export type ReservedKeyword = "ultrawork" | "mass-ulw" | "ulw-plan" | "ulw-loop" | "ulw-research";

export interface ReservedKeywordSpan {
	readonly keyword: ReservedKeyword;
	/** UTF-16 offsets into the searched text, end exclusive. */
	readonly start: number;
	readonly end: number;
}

export interface ReservedKeywordRun {
	readonly start: number;
	readonly end: number;
}

const MASS_ULW_ALIAS = String.raw`(?:mass[\s-]*ulw|ulw[\s-]*mass|mulw|meth)`;

// A keyword glued to a preceding identifier segment (`mass-ulw`, `senpi-ulw-loop`, `.omo/ulw/`, `v1.ulw`)
// names something else; so does one that opens a path (`ulw-execute/ledger.jsonl`).
const NOT_AFTER_IDENTIFIER = String.raw`(?<![A-Za-z0-9][-_.]|[/\\])`;
const NOT_BEFORE_PATH = String.raw`(?![-_.]?[A-Za-z0-9]*[/\\])`;
// The name must end its own word (`ulw-plan-refactor`, `ulw-plan.md` do not count); a chained
// skill word may follow if it, too, ends there (`mass ulw-loop`).
const SEGMENT_END = String.raw`(?![-_.]?[A-Za-z0-9])`;
const NOT_INTO_IDENTIFIER = String.raw`(?![-_](?!(?:loop|plan|research|execute|mass)${SEGMENT_END})[A-Za-z0-9]|\.[A-Za-z0-9])`;

const keywordPattern = (body: string): RegExp =>
	new RegExp(String.raw`${NOT_AFTER_IDENTIFIER}\b${body}\b${NOT_INTO_IDENTIFIER}${NOT_BEFORE_PATH}`, "gi");

const RESERVED_KEYWORD_PATTERNS: ReadonlyArray<readonly [ReservedKeyword, RegExp]> = [
	["ultrawork", keywordPattern("(?:ultrawork|ulw)")],
	["mass-ulw", keywordPattern(MASS_ULW_ALIAS)],
	["ulw-plan", keywordPattern(String.raw`ulw[\s-]*plan`)],
	["ulw-loop", keywordPattern(String.raw`ulw[\s-]*loop`)],
	["ulw-research", keywordPattern(String.raw`(?:ulw|${MASS_ULW_ALIAS})[\s-]*research`)],
];

/** Cheap pre-check: every reserved keyword contains one of these stems. */
const RESERVED_KEYWORD_STEM = /ulw|ultrawork|mulw|meth/i;

const INJECTED_BLOCK = /<(omo-[a-z0-9-]+-pointer|ultrawork-mode|omo-ultrawork-reminder)>[\s\S]*?<\/\1>/gi;
const INLINE_CODE = /(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g;
// A relayed message opens with a sender header (`[REPORT]`, `[a -> b]`, `Name (id), recipient:`): all of it is someone else's text.
const RELAY_HEADER =
	/^\s*(?:\[(?:[A-Z][A-Z0-9_-]{2,}|[\w.-]+ -> [\w.-]+)\]|[A-Z][\w.-]{0,30} \([^()\s]{1,40}\)(?:, | to )[\w.-]{1,40}:)/;
const BLOCK_QUOTE_LINE = /^ {0,3}>[^\n]*/gm;
const DOUBLE_QUOTED = /"[^"\n]*"|\u201C[^\u201D\n]*\u201D/g;
const URL_SPAN = /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi;
// A keyword named only to forbid it ("Do not load mass-ulw or ulw-research") is masked up to the next clause break.
const NEGATED_INVOCATION =
	/\b(?:do\s+not|don['\u2019]t|dont|never)\s+(?:load|use|run|invoke|start|trigger|arm|enable)\b[^.;:!?\n]*?(?=[.;:!?\n]|\s(?:but|then|instead|however)\b|\s[\u2014\u2013-]\s|$)/gi;

function maskRegion(region: string): string {
	return region.replace(/[^\r\n]/g, "\0");
}

/** Quoted, injected, relayed and negated regions are masked (offsets kept) before matching. */
function maskQuotedRegions(text: string): string {
	if (RELAY_HEADER.test(text)) return maskRegion(text);
	let visible = text.replace(INJECTED_BLOCK, maskRegion);
	const fenceStart = /^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)/gm;
	for (let opening = fenceStart.exec(visible); opening !== null; opening = fenceStart.exec(visible)) {
		const fence = opening[1] ?? "```";
		const fenceEnd = new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \\t]*\\r?$`, "gm");
		fenceEnd.lastIndex = fenceStart.lastIndex;
		const closing = fenceEnd.exec(visible);
		const end = closing === null ? visible.length : fenceEnd.lastIndex;
		visible = visible.slice(0, opening.index) + maskRegion(visible.slice(opening.index, end)) + visible.slice(end);
		fenceStart.lastIndex = end;
	}
	return visible
		.replace(INLINE_CODE, maskRegion)
		.replace(BLOCK_QUOTE_LINE, maskRegion)
		.replace(DOUBLE_QUOTED, maskRegion)
		.replace(URL_SPAN, maskRegion)
		.replace(NEGATED_INVOCATION, maskRegion);
}

/** Every reserved-keyword mention outside quoted regions, in text order. */
export function findReservedKeywordSpans(text: string): ReservedKeywordSpan[] {
	if (!RESERVED_KEYWORD_STEM.test(text)) return [];
	const visible = maskQuotedRegions(text);
	const spans: ReservedKeywordSpan[] = [];
	for (const [keyword, pattern] of RESERVED_KEYWORD_PATTERNS) {
		for (const match of visible.matchAll(pattern)) {
			spans.push({ keyword, start: match.index, end: match.index + match[0].length });
		}
	}
	return spans.sort((left, right) => left.start - right.start || right.end - left.end);
}

/** Overlapping mentions ("mass ulw research" is three) merge into one painted run, as on the desktop. */
export function findReservedKeywordRuns(text: string): ReservedKeywordRun[] {
	const runs: { start: number; end: number }[] = [];
	for (const span of findReservedKeywordSpans(text)) {
		const previous = runs.at(-1);
		if (previous !== undefined && span.start <= previous.end) {
			previous.end = Math.max(previous.end, span.end);
		} else {
			runs.push({ start: span.start, end: span.end });
		}
	}
	return runs;
}
