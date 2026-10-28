import { RE2JS, RE2JSException } from "re2js";

import {
	type CompiledLineMatcher,
	type GroupSpan,
	type LineMatch,
	type LineMatcher,
	MatcherCompileError,
} from "./matcher.ts";

/**
 * The production {@link LineMatcher}, backed by re2js (a JavaScript port of RE2): automata
 * matching without backtracking, so a model-written pattern runs in time linear in the line.
 * Patterns compile with no flags; `RE2JS.LOOKBEHINDS` is never set, so lookaround and
 * backreferences stay compile errors here as well as in {@link compilePatterns}. re2js reads both
 * `(?<name>…)` and `(?P<name>…)`, and reports spans in UTF-16 units, as the port wants.
 */
export class Re2LineMatcher implements LineMatcher {
	compile(patterns: readonly string[]): CompiledLineMatcher {
		const compiled = patterns.map((pattern, index) => compilePattern(pattern, index));
		const groupNames = compiled.map(({ groups }) => groups.map(([name]) => name));
		return {
			groupNames,
			matchLines(lines: readonly string[]): LineMatch[] {
				const matches: LineMatch[] = [];
				lines.forEach((line, lineIndex) => {
					compiled.forEach(({ expression, groups }, pattern) => {
						const matcher = expression.matcher(line);
						if (!matcher.find()) return;
						const spans = groups.map(([, group]): GroupSpan | undefined => {
							const start = matcher.start(group);
							return start < 0 ? undefined : { start, end: matcher.end(group) };
						});
						matches.push({ line: lineIndex, pattern, spans });
					});
				});
				return matches;
			},
		};
	}
}

interface CompiledPattern {
	expression: RE2JS;
	/** Named groups as `[name, group index]`, in pattern order. */
	groups: [string, number][];
}

function compilePattern(pattern: string, index: number): CompiledPattern {
	let expression: RE2JS;
	try {
		expression = RE2JS.compile(pattern);
	} catch (error) {
		if (error instanceof RE2JSException) throw new MatcherCompileError(index, error.message);
		throw error;
	}
	const groups = Object.entries(expression.namedGroups()).sort(([, a], [, b]) => a - b);
	return { expression, groups };
}

/** The matcher job widgets run on: linear-time RE2 semantics. Stateless, so one instance is shared. */
export const defaultLineMatcher: LineMatcher = new Re2LineMatcher();
