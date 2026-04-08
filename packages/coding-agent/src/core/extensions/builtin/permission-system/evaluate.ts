import { Wildcard } from "../agent-system/wildcard.js";
import type { Rule, Ruleset } from "../permission-system/types.js";

declare global {
	interface Array<T> {
		findLast<S extends T>(
			predicate: (value: T, index: number, array: T[]) => value is S,
			thisArg?: unknown,
		): S | undefined;
		findLast(predicate: (value: T, index: number, array: T[]) => unknown, thisArg?: unknown): T | undefined;
	}
}

export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
	const matchedRule = rulesets.flat().findLast((rule) => {
		return Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern);
	});

	if (matchedRule) {
		return matchedRule;
	}

	return { action: "ask", permission, pattern: "*" };
}
