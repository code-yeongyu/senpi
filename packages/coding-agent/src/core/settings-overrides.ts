import type { Settings } from "./settings-manager.ts";

type SettingsRecord = Record<string, unknown>;

function isRecord(value: unknown): value is SettingsRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The override layer without `field` (or only `field.nestedKey`), so an explicit
 * setter for that key wins over a CLI/programmatic override while every other
 * override keeps applying. Empty parents are dropped; the input is not mutated.
 */
export function withoutOverride(overrides: Settings, field: keyof Settings, nestedKey?: string): Settings {
	if (!(field in overrides)) return overrides;
	const next: SettingsRecord = { ...(overrides as SettingsRecord) };
	const current = next[field];
	if (nestedKey === undefined || !isRecord(current)) {
		delete next[field];
		return next as Settings;
	}
	if (!(nestedKey in current)) return overrides;
	const nested: SettingsRecord = { ...current };
	delete nested[nestedKey];
	if (Object.keys(nested).length === 0) delete next[field];
	else next[field] = nested;
	return next as Settings;
}
