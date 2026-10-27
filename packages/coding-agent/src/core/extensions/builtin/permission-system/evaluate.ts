import type { Rule, Ruleset } from "../permission-system/types.ts";
import { createExternalPathMatcher } from "./external-pattern.ts";
import { Wildcard } from "./wildcard.ts";

declare global {
	interface Array<T> {
		findLast<S extends T>(
			predicate: (value: T, index: number, array: T[]) => value is S,
			thisArg?: unknown,
		): S | undefined;
		findLast(predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: unknown): T | undefined;
	}
}

export function evaluate(permission: string, pattern: string | readonly string[], ...rulesets: Ruleset[]): Rule {
	const matchesExternalPath = permission === "external_directory" ? createExternalPathMatcher() : undefined;
	return evaluatePatterns(permission, pattern, rulesets, matchesExternalPath);
}

/** Evaluate a lexical spelling without letting a resolved rule erase its ancestry. */
export function evaluateExternalSpelling(
	pattern: string | readonly string[],
	ruleset: Ruleset,
	canonicalCase?: (value: string) => string,
): Rule {
	return evaluatePatterns("external_directory", pattern, [ruleset], createExternalPathMatcher(true, canonicalCase));
}

function evaluatePatterns(
	permission: string,
	pattern: string | readonly string[],
	rulesets: Ruleset[],
	matchesExternalPath?: (value: string, pattern: string) => boolean,
): Rule {
	const patterns = typeof pattern === "string" ? [pattern] : pattern;
	const matchedRule = rulesets.flat().findLast((rule) => {
		return (
			Wildcard.match(permission, rule.permission) &&
			patterns.some((value) => matchesPattern(value, rule.pattern) || matchesExternalPath?.(value, rule.pattern))
		);
	});

	if (matchedRule) {
		return matchedRule;
	}

	return { action: "ask", permission, pattern: "*" };
}

function matchesPattern(value: string, pattern: string): boolean {
	return Wildcard.match(value, pattern) || (pattern.endsWith(" *") && Wildcard.match(value, pattern.slice(0, -2)));
}
