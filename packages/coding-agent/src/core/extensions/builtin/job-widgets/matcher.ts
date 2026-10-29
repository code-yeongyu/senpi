/**
 * The line-matching port. Widget patterns are model-written, so the production engine must run in
 * linear time (RE2 semantics); a JS `RegExp` can backtrack catastrophically and is not shipped as
 * an engine. {@link compilePatterns} rejects what RE2 cannot run (lookaround, backreferences,
 * recursion and subroutine calls, conditionals, backtracking verbs) in every spelling before an
 * engine sees a pattern, and hands it one group spelling, `(?<name>…)`.
 */

/** Span of one named group's capture in a line, in UTF-16 units. */
export interface GroupSpan {
	start: number;
	end: number;
}

export interface LineMatch {
	/** Index of the matched line in the input. */
	line: number;
	/** Index of the pattern that matched. */
	pattern: number;
	/** Per named group of the pattern, in `groupNames[pattern]` order; `undefined` when it took no part. */
	spans: readonly (GroupSpan | undefined)[];
}

export interface CompiledLineMatcher {
	/** Named groups of each pattern, in pattern order. */
	readonly groupNames: readonly (readonly string[])[];
	/** Every pattern's leftmost match on every line, ordered by line, then by pattern. */
	matchLines(lines: readonly string[]): LineMatch[];
}

/** A linear-time regex engine. `compile` throws {@link MatcherCompileError} for a pattern it rejects. */
export interface LineMatcher {
	compile(patterns: readonly string[]): CompiledLineMatcher;
}

export class MatcherCompileError extends Error {
	/** Index of the rejected pattern. */
	readonly pattern: number;
	readonly reason: string;

	constructor(pattern: number, reason: string) {
		super(`pattern ${pattern}: ${reason}`);
		this.name = "MatcherCompileError";
		this.pattern = pattern;
		this.reason = reason;
	}
}

export interface PatternScan {
	/** Named groups in pattern order. */
	groups: string[];
	/** The pattern with every `(?P<name>` spelled `(?<name>`. */
	normalized: string;
	/** Why the pattern cannot run on a linear-time engine. */
	error?: string;
}

const NAMED_GROUP_AT = /^\(\?P?<([A-Za-z_][A-Za-z0-9_]*)>/;

/**
 * Why the escape whose letter is at `at` (outside a class) needs a backtracking engine: `\1`-`\9`,
 * `\k<n>`, `\k'n'`, `\k{n}`, `\g1`, `\g-1`, `\g{n}` refer back, `\g<n>` and `\g'n'` call a group.
 */
function escapeReference(pattern: string, at: number): string | undefined {
	const letter = pattern.charAt(at);
	const after = pattern.charAt(at + 1);
	if (letter >= "1" && letter <= "9") return `backreference \\${letter} is not supported`;
	if (letter === "k" && (after === "<" || after === "'" || after === "{")) {
		return `named backreference \\k${after}… is not supported`;
	}
	if (letter === "g") {
		if (after === "<" || after === "'") return `subroutine call (recursion) \\g${after}… is not supported`;
		if (after === "{" || after === "-" || after === "+" || (after >= "0" && after <= "9")) {
			return `backreference \\g${after}… is not supported`;
		}
	}
	return undefined;
}

/** Why the `(?` construct starting at `at` (the `(`) needs a backtracking engine. */
function groupConstruct(pattern: string, at: number): string | undefined {
	const rest = pattern.slice(at + 2, at + 4);
	if (/^(?:[=!*]|<[=!*])/.test(rest)) return "lookaround (?=, (?!, (?<=, (?<! is not supported";
	if (rest.startsWith("P=")) return "named backreference (?P=…) is not supported";
	if (rest.startsWith("P>") || rest.startsWith("&") || /^(?:R|[+-]?\d)/.test(rest)) {
		return "recursion (?R), (?1), (?&…), (?P>…) is not supported";
	}
	if (rest.startsWith("(")) return "conditional (?(…) is not supported";
	return undefined;
}

/** Reads a pattern's named groups and constructs outside escapes and character classes. */
export function scanPattern(pattern: string): PatternScan {
	const groups: string[] = [];
	let normalized = "";
	let inClass = false;
	const fail = (error: string): PatternScan => ({ groups, normalized: pattern, error });
	for (let index = 0; index < pattern.length; index++) {
		const char = pattern.charAt(index);
		if (char === "\\") {
			const next = pattern.charAt(index + 1);
			const reference = inClass ? undefined : escapeReference(pattern, index + 1);
			if (reference !== undefined) return fail(reference);
			normalized += char + next;
			index += 1;
			continue;
		}
		if (inClass) {
			if (char === "]") inClass = false;
			normalized += char;
			continue;
		}
		if (char === "[") {
			inClass = true;
			normalized += char;
			// A `]` right after `[` or `[^` is a literal member, not the class end.
			if (pattern.charAt(index + 1) === "^") normalized += pattern.charAt(++index);
			if (pattern.charAt(index + 1) === "]") normalized += pattern.charAt(++index);
			continue;
		}
		if (char === "(" && pattern.charAt(index + 1) === "*") {
			return fail("backtracking verb or alpha assertion (*…) is not supported");
		}
		if (char === "(" && pattern.charAt(index + 1) === "?") {
			const construct = groupConstruct(pattern, index);
			if (construct !== undefined) return fail(construct);
			const named = NAMED_GROUP_AT.exec(pattern.slice(index));
			if (named) {
				groups.push(named[1]);
				normalized += `(?<${named[1]}>`;
				index += named[0].length - 1;
				continue;
			}
		}
		normalized += char;
	}
	return { groups, normalized };
}

/** Named groups a pattern declares, in pattern order. */
export function patternGroupNames(pattern: string): string[] {
	return scanPattern(pattern).groups;
}

/** Checks every pattern's syntax, then compiles the normalized patterns on `matcher`. */
export function compilePatterns(matcher: LineMatcher, patterns: readonly string[]): CompiledLineMatcher {
	const normalized = patterns.map((pattern, index) => {
		const scan = scanPattern(pattern);
		if (scan.error !== undefined) throw new MatcherCompileError(index, scan.error);
		return scan.normalized;
	});
	return matcher.compile(normalized);
}
