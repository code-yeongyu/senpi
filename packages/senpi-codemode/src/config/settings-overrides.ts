import type { CodemodeSettings } from "./settings.ts";
import {
	DEFAULT_MAX_DETACHED_CELLS,
	type Environment,
	FOREGROUND_WINDOW_ENVIRONMENT_FLAG,
	HARD_LIMIT_ENVIRONMENT_FLAG,
	MAX_DETACHED_CELLS_ENVIRONMENT_FLAG,
	RUN_BUDGET_ENVIRONMENT_FLAG,
} from "./settings-constants.ts";

const languageEnvironmentFlags = {
	py: "SENPI_CODEMODE_PY",
	js: "SENPI_CODEMODE_JS",
	rb: "SENPI_CODEMODE_RB",
	jl: "SENPI_CODEMODE_JL",
} as const;

export function resolveEnabledLanguages(
	settings: CodemodeSettings,
	env: Environment = process.env,
): CodemodeSettings["languages"] {
	return {
		// Keep the non-flag keys (languages.pyInterpreter); only the four enable flags take env overrides.
		...settings.languages,
		py: resolveLanguage(settings.languages.py, env[languageEnvironmentFlags.py]),
		js: resolveLanguage(settings.languages.js, env[languageEnvironmentFlags.js]),
		rb: resolveLanguage(settings.languages.rb, env[languageEnvironmentFlags.rb]),
		jl: resolveLanguage(settings.languages.jl, env[languageEnvironmentFlags.jl]),
	};
}

/** Environment override wins over the settings file; a non-positive or malformed value is ignored. */
export function resolveHardLimitSeconds(settings: CodemodeSettings, env: Environment = process.env): number {
	return positiveSecondsOverride(env[HARD_LIMIT_ENVIRONMENT_FLAG]) ?? settings.hardLimitSeconds;
}

/** Environment override wins over the settings file; a non-positive or malformed value is ignored. */
export function resolveForegroundWindowSeconds(settings: CodemodeSettings, env: Environment = process.env): number {
	return positiveSecondsOverride(env[FOREGROUND_WINDOW_ENVIRONMENT_FLAG]) ?? settings.foregroundWindowSeconds;
}

/** Environment override wins over the settings file; a non-positive or malformed value is ignored. */
export function resolveRunBudgetSeconds(settings: CodemodeSettings, env: Environment = process.env): number {
	return positiveSecondsOverride(env[RUN_BUDGET_ENVIRONMENT_FLAG]) ?? settings.runBudgetSeconds;
}

/** Uses the same positive-integer environment parsing as the run budget. */
export function resolveMaxDetachedCells(settings: CodemodeSettings, env: Environment = process.env): number {
	return (
		positiveSecondsOverride(env[MAX_DETACHED_CELLS_ENVIRONMENT_FLAG]) ??
		settings.maxDetachedCells ??
		DEFAULT_MAX_DETACHED_CELLS
	);
}

function positiveSecondsOverride(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveLanguage(fileSetting: boolean, environmentValue: string | undefined): boolean {
	if (environmentValue === undefined) return fileSetting;
	switch (environmentValue.trim().toLowerCase()) {
		case "0":
		case "false":
			return false;
		case "1":
		case "true":
			return true;
		default:
			return fileSetting;
	}
}
