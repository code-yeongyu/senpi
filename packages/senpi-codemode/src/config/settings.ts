import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Static } from "typebox";
import { Type } from "typebox";
import { Check } from "typebox/value";

export const codemodeSettingsSchema = Type.Object(
	{
		languages: Type.Optional(
			Type.Object(
				{
					py: Type.Optional(Type.Boolean()),
					js: Type.Optional(Type.Boolean()),
					rb: Type.Optional(Type.Boolean()),
					jl: Type.Optional(Type.Boolean()),
				},
				{ additionalProperties: false },
			),
		),
		cellTimeoutSeconds: Type.Optional(Type.Number({ minimum: 1 })),
		foregroundWindowSeconds: Type.Optional(Type.Number({ minimum: 1 })),
		runBudgetSeconds: Type.Optional(Type.Number({ minimum: 1 })),
		hardLimitSeconds: Type.Optional(Type.Number({ minimum: 1 })),
		parallelPoolWidth: Type.Optional(Type.Number({ minimum: 1 })),
		taskTools: Type.Optional(
			Type.Object(
				{
					task: Type.Optional(Type.String()),
					output: Type.Optional(Type.String()),
				},
				{ additionalProperties: false },
			),
		),
		outputSink: Type.Optional(
			Type.Object(
				{
					headBytes: Type.Optional(Type.Number({ minimum: 0 })),
					maxColumns: Type.Optional(Type.Number({ minimum: 0 })),
				},
				{ additionalProperties: false },
			),
		),
		statusEvents: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export type CodemodeSettingsInput = Static<typeof codemodeSettingsSchema>;

export interface CodemodeTaskTools {
	readonly task: string;
	readonly output: string;
}

export interface CodemodeOutputSink {
	readonly headBytes: number;
	readonly maxColumns: number;
}

export interface CodemodeSettings {
	readonly languages: {
		readonly py: boolean;
		readonly js: boolean;
		readonly rb: boolean;
		readonly jl: boolean;
	};
	/** Idle time an interactive call blocks the turn before the cell detaches; capped by the foreground window. */
	readonly cellTimeoutSeconds: number;
	/**
	 * Longest an interactive eval call blocks the agent loop before the cell detaches, capping
	 * `cellTimeoutSeconds` and the bridge-parked grace. A still-running cell keeps living up to its
	 * run budget and the hard limit; this only frees the turn. Print/json calls never detach.
	 */
	readonly foregroundWindowSeconds: number;
	/**
	 * Kill deadline for a cell's own execution time — child processes, network, timers, CPU — with
	 * time parked on host tool calls excluded. A per-call `timeout` replaces it for that cell.
	 */
	readonly runBudgetSeconds: number;
	/** Wall-clock kill deadline for a single cell; bounds detached and bridge-parked cells too. */
	readonly hardLimitSeconds: number;
	readonly parallelPoolWidth: number;
	readonly taskTools?: CodemodeTaskTools;
	readonly outputSink?: CodemodeOutputSink;
	readonly statusEvents?: boolean;
}

export type ResolvedCodemodeSettings = CodemodeSettings & {
	readonly taskTools: CodemodeTaskTools;
	readonly outputSink: CodemodeOutputSink;
	readonly statusEvents: boolean;
};

export interface LoadCodemodeSettingsOptions {
	readonly cwd?: string;
	readonly homeDir?: string;
}

export interface LoadedCodemodeSettings {
	readonly settings: ResolvedCodemodeSettings;
	readonly source: string | null;
	readonly warnings: readonly string[];
}

/**
 * Bash parity: `bash-timeout/timeout.ts` kills a command at 1800s. An eval cell gets the same
 * unconditional wall-clock kill deadline, which — unlike `cellTimeoutSeconds` — is neither paused by
 * host tool calls nor discarded when the cell detaches.
 */
export const DEFAULT_HARD_LIMIT_SECONDS = 1800;

export const HARD_LIMIT_ENVIRONMENT_FLAG = "SENPI_CODEMODE_HARD_LIMIT_SECONDS";

/**
 * Bash parity: `terminal/tools/foreground-window.ts` auto-detaches a still-running bash command to a
 * background session at 60s regardless of its `timeout` kill deadline. An eval cell gets the same
 * default foreground window so a large `timeout` extends the cell's lifetime without holding the turn
 * hostage for hours.
 */
export const DEFAULT_FOREGROUND_WINDOW_SECONDS = 60;

export const FOREGROUND_WINDOW_ENVIRONMENT_FLAG = "SENPI_CODEMODE_FOREGROUND_SECONDS";

/**
 * One language kernel runs one cell at a time and a killed JavaScript cell that cannot settle
 * cooperatively restarts its worker, so a runaway cell costs far more than a runaway bash command:
 * five minutes of own execution time is the default before the cell is killed.
 */
export const DEFAULT_RUN_BUDGET_SECONDS = 300;

export const RUN_BUDGET_ENVIRONMENT_FLAG = "SENPI_CODEMODE_RUN_BUDGET_SECONDS";

// OMP settings-schema.ts:3211-3299 has language/path settings only; eval.ts:427
// defaults timeout to 30s, and codemode pins concurrency-bridge.ts:30 width to 4.
export const defaultCodemodeSettings: ResolvedCodemodeSettings = {
	languages: {
		py: true,
		js: true,
		rb: false,
		jl: false,
	},
	cellTimeoutSeconds: 30,
	foregroundWindowSeconds: DEFAULT_FOREGROUND_WINDOW_SECONDS,
	runBudgetSeconds: DEFAULT_RUN_BUDGET_SECONDS,
	hardLimitSeconds: DEFAULT_HARD_LIMIT_SECONDS,
	parallelPoolWidth: 4,
	taskTools: {
		task: "task",
		output: "task_output",
	},
	outputSink: {
		headBytes: 20_480,
		maxColumns: 768,
	},
	statusEvents: true,
};

const languageEnvironmentFlags = {
	py: "SENPI_CODEMODE_PY",
	js: "SENPI_CODEMODE_JS",
	rb: "SENPI_CODEMODE_RB",
	jl: "SENPI_CODEMODE_JL",
} as const;

type Environment = Readonly<Record<string, string | undefined>>;

export async function loadCodemodeSettings(options: LoadCodemodeSettingsOptions = {}): Promise<LoadedCodemodeSettings> {
	const cwd = options.cwd ?? process.cwd();
	const homeDir = options.homeDir ?? homedir();
	const candidates = [join(cwd, ".senpi", "codemode.json"), join(homeDir, ".senpi", "agent", "codemode.json")];

	for (const candidate of candidates) {
		if (!(await fileExists(candidate))) {
			continue;
		}
		return loadSettingsFile(candidate);
	}

	return { settings: defaultCodemodeSettings, source: null, warnings: [] };
}

export function resolveEnabledLanguages(
	settings: CodemodeSettings,
	env: Environment = process.env,
): CodemodeSettings["languages"] {
	return {
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

function positiveSecondsOverride(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

async function loadSettingsFile(path: string): Promise<LoadedCodemodeSettings> {
	const raw = await readFile(path, "utf8");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			settings: defaultCodemodeSettings,
			source: path,
			warnings: [`Invalid JSON in ${path}: ${message}. Falling back to codemode defaults.`],
		};
	}

	if (!Check(codemodeSettingsSchema, parsed)) {
		return {
			settings: defaultCodemodeSettings,
			source: path,
			warnings: [`Invalid codemode settings in ${path}. Falling back to codemode defaults.`],
		};
	}

	return { settings: mergeSettings(parsed), source: path, warnings: [] };
}

function mergeSettings(input: CodemodeSettingsInput): ResolvedCodemodeSettings {
	return {
		languages: {
			py: input.languages?.py ?? defaultCodemodeSettings.languages.py,
			js: input.languages?.js ?? defaultCodemodeSettings.languages.js,
			rb: input.languages?.rb ?? defaultCodemodeSettings.languages.rb,
			jl: input.languages?.jl ?? defaultCodemodeSettings.languages.jl,
		},
		cellTimeoutSeconds: input.cellTimeoutSeconds ?? defaultCodemodeSettings.cellTimeoutSeconds,
		foregroundWindowSeconds: input.foregroundWindowSeconds ?? defaultCodemodeSettings.foregroundWindowSeconds,
		runBudgetSeconds: input.runBudgetSeconds ?? defaultCodemodeSettings.runBudgetSeconds,
		hardLimitSeconds: input.hardLimitSeconds ?? defaultCodemodeSettings.hardLimitSeconds,
		parallelPoolWidth: input.parallelPoolWidth ?? defaultCodemodeSettings.parallelPoolWidth,
		taskTools: {
			task: input.taskTools?.task ?? defaultCodemodeSettings.taskTools.task,
			output: input.taskTools?.output ?? defaultCodemodeSettings.taskTools.output,
		},
		outputSink: {
			headBytes: input.outputSink?.headBytes ?? defaultCodemodeSettings.outputSink.headBytes,
			maxColumns: input.outputSink?.maxColumns ?? defaultCodemodeSettings.outputSink.maxColumns,
		},
		statusEvents: input.statusEvents ?? defaultCodemodeSettings.statusEvents,
	};
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

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
