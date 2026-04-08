import type { ExtensionAPI } from "../../types.js";
import type { Action, Rule, Ruleset } from "./types.js";

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

export function registerPermissionFlag(pi: ExtensionAPI): Ruleset {
	pi.registerFlag("permission", {
		description: "Set permission rules (format: tool=action or tool:pattern=action)",
		type: "string",
	});

	return [];
}

export function loadPermissionFlag(pi: ExtensionAPI): Ruleset {
	const flagValue = pi.getFlag("permission") as string | undefined;
	if (!flagValue) return [];
	return parsePermissionFlag(flagValue);
}
