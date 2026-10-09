import type { Action, PermissionPresetName, Rule, Ruleset } from "./types.ts";

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

export function parsePermissionPresetFlag(value: string): PermissionPresetName | undefined {
	return parsePermissionPresetName(value.trim());
}

export const PERMISSION_PRESET_NAMES: readonly PermissionPresetName[] = [
	"full-access",
	"workspace",
	"accept-edits",
	"auto",
	"read-only",
	"ask",
];

export function parsePermissionPresetName(value: string): PermissionPresetName | undefined {
	return PERMISSION_PRESET_NAMES.find((name) => name === value);
}
