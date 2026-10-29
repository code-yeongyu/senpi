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
	return evaluatePatterns(permission, pattern, rulesets, externalPathMatcherFor(permission));
}

/** `external_directory` always carries its on-disk identity matcher, whichever evaluate form decides it. */
function externalPathMatcherFor(permission: string): ((value: string, pattern: string) => boolean) | undefined {
	return permission === "external_directory" ? createExternalPathMatcher() : undefined;
}

/** A rule matches when it covers a pattern as written, as executed, or by file identity of the request. */
export type IdentityMatcher = (rulePattern: string) => boolean;

/**
 * `evaluate` plus the identity route (design 6.2): the predicate takes the RULE only and tests every
 * canonical path of the request. The external-path matcher stays in place; identity is added to it.
 */
export function evaluateWithIdentity(
	permission: string,
	pattern: string | readonly string[],
	ruleset: Ruleset,
	matchesIdentity: IdentityMatcher | undefined,
): Rule {
	return evaluatePatterns(permission, pattern, [ruleset], externalPathMatcherFor(permission), matchesIdentity);
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
	matchesIdentity?: IdentityMatcher,
): Rule {
	const patterns = typeof pattern === "string" ? [pattern] : pattern;
	const matchedRule = rulesets.flat().findLast((rule) => {
		return (
			Wildcard.match(permission, rule.permission) &&
			(patterns.some((value) => matchesPattern(value, rule.pattern) || matchesExternalPath?.(value, rule.pattern)) ||
				(matchesIdentity?.(rule.pattern) ?? false))
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
