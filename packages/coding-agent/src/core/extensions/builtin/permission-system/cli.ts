import type { Action, Rule, Ruleset } from "./types.ts";

export function parsePermissionFlag(value: string): Ruleset {
	const rules: Rule[] = [];
	const entries = value.split(",");

	for (const entry of entries) {
		const trimmed = entry.trim();
		if (!trimmed) continue;

		const match = trimmed.match(/^([^:=]+)(?::([^=]+))?=(.+)$/);
		if (!match) continue;

		const [, permission, pattern, action] = match;
		rules.push({
			permission: permission.trim(),
			pattern: pattern ? pattern.trim() : "*",
			action: action.trim() as Action,
		});
	}

	return rules;
}
