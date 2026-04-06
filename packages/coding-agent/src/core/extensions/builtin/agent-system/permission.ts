import type { PermissionConfig, Rule, Ruleset } from "./types.js";
import { Wildcard } from "./wildcard.js";

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

export function fromConfig(config: PermissionConfig): Ruleset {
	return Object.entries(config).flatMap(([permission, value]) => {
		if (typeof value === "string") {
			return [{ permission, pattern: "*", action: value }];
		}

		return Object.entries(value).map(([pattern, action]) => {
			return { permission, pattern, action };
		});
	});
}

export function merge(...rulesets: Ruleset[]): Ruleset {
	return rulesets.flat();
}
