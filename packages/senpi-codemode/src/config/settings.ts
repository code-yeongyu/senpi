import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Static } from "typebox";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { type CodemodeFeatureSettings, featureSettingsProperties, pickFeatureSettings } from "./feature-settings.ts";
import { type CodemodeMemorySettings, memorySettingsSchema, validatedMemorySettings } from "./memory-settings.ts";
import { DEFAULT_MAX_DETACHED_CELLS } from "./settings-constants.ts";
import { withoutUnknownTopLevelKeys } from "./unknown-settings.ts";

export const codemodeSettingsSchema = Type.Object(
	{
		languages: Type.Optional(
			Type.Object(
				{
					py: Type.Optional(Type.Boolean()),
					js: Type.Optional(Type.Boolean()),
					rb: Type.Optional(Type.Boolean()),
					jl: Type.Optional(Type.Boolean()),
					pyInterpreter: Type.Optional(Type.String({ minLength: 1 })),
				},
				{ additionalProperties: false },
			),
		),
		cellTimeoutSeconds: Type.Optional(Type.Number({ minimum: 1 })),
		foregroundWindowSeconds: Type.Optional(Type.Number({ minimum: 1 })),
		runBudgetSeconds: Type.Optional(Type.Number({ minimum: 1 })),
		hardLimitSeconds: Type.Optional(Type.Number({ minimum: 1 })),
		maxDetachedCells: Type.Optional(Type.Number({ minimum: 1 })),
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
		memory: Type.Optional(memorySettingsSchema),
		...featureSettingsProperties,
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

export interface CodemodeSettings extends CodemodeFeatureSettings {
	readonly languages: {
		readonly py: boolean;
		readonly js: boolean;
		readonly rb: boolean;
		readonly jl: boolean;
		/** Explicit Python interpreter; unset keeps today's PATH detection. */
		readonly pyInterpreter?: string;
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
	/** Maximum detached cells across all language kernels. */
	readonly maxDetachedCells?: number;
	readonly parallelPoolWidth: number;
	readonly taskTools?: CodemodeTaskTools;
	readonly outputSink?: CodemodeOutputSink;
	readonly statusEvents?: boolean;
	readonly memory?: CodemodeMemorySettings;
}

export type ResolvedCodemodeSettings = CodemodeSettings & {
	readonly maxDetachedCells: number;
	readonly taskTools: CodemodeTaskTools;
	readonly outputSink: CodemodeOutputSink;
	readonly statusEvents: boolean;
	readonly memory: CodemodeMemorySettings;
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

/**
 * Bash parity: `terminal/tools/foreground-window.ts` auto-detaches a still-running bash command to a
 * background session at 60s regardless of its `timeout` kill deadline. An eval cell gets the same
 * default foreground window so a large `timeout` extends the cell's lifetime without holding the turn
 * hostage for hours.
 */
export const DEFAULT_FOREGROUND_WINDOW_SECONDS = 60;

/**
 * One language kernel runs one cell at a time and a killed JavaScript cell that cannot settle
 * cooperatively restarts its worker, so a runaway cell costs far more than a runaway bash command:
 * five minutes of own execution time is the default before the cell is killed.
 */
export const DEFAULT_RUN_BUDGET_SECONDS = 300;

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
	maxDetachedCells: DEFAULT_MAX_DETACHED_CELLS,
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
	memory: validatedMemorySettings(undefined).settings,
};

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

	const known = withoutUnknownTopLevelKeys(parsed, new Set(Object.keys(codemodeSettingsSchema.properties)), path);
	const candidate = known.value;
	if (!Check(codemodeSettingsSchema, candidate)) {
		return {
			settings: defaultCodemodeSettings,
			source: path,
			warnings: [...known.warnings, `Invalid codemode settings in ${path}. Falling back to codemode defaults.`],
		};
	}

	return {
		settings: mergeSettings(candidate),
		source: path,
		warnings: [...known.warnings, ...validatedMemorySettings(candidate.memory).warnings],
	};
}

function mergeSettings(input: CodemodeSettingsInput): ResolvedCodemodeSettings {
	return {
		languages: {
			py: input.languages?.py ?? defaultCodemodeSettings.languages.py,
			js: input.languages?.js ?? defaultCodemodeSettings.languages.js,
			rb: input.languages?.rb ?? defaultCodemodeSettings.languages.rb,
			jl: input.languages?.jl ?? defaultCodemodeSettings.languages.jl,
			...(input.languages?.pyInterpreter === undefined ? {} : { pyInterpreter: input.languages.pyInterpreter }),
		},
		cellTimeoutSeconds: input.cellTimeoutSeconds ?? defaultCodemodeSettings.cellTimeoutSeconds,
		foregroundWindowSeconds: input.foregroundWindowSeconds ?? defaultCodemodeSettings.foregroundWindowSeconds,
		runBudgetSeconds: input.runBudgetSeconds ?? defaultCodemodeSettings.runBudgetSeconds,
		hardLimitSeconds: input.hardLimitSeconds ?? defaultCodemodeSettings.hardLimitSeconds,
		maxDetachedCells: input.maxDetachedCells ?? DEFAULT_MAX_DETACHED_CELLS,
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
		memory: validatedMemorySettings(input.memory).settings,
		...pickFeatureSettings(input),
	};
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export {
	DEFAULT_MAX_DETACHED_CELLS,
	type Environment,
	FOREGROUND_WINDOW_ENVIRONMENT_FLAG,
	HARD_LIMIT_ENVIRONMENT_FLAG,
	MAX_DETACHED_CELLS_ENVIRONMENT_FLAG,
	RUN_BUDGET_ENVIRONMENT_FLAG,
} from "./settings-constants.ts";
export {
	resolveEnabledLanguages,
	resolveForegroundWindowSeconds,
	resolveHardLimitSeconds,
	resolveMaxDetachedCells,
	resolveRunBudgetSeconds,
} from "./settings-overrides.ts";
