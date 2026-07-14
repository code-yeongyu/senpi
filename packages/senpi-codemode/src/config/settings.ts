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
	readonly cellTimeoutSeconds: number;
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
