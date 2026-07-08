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
	},
	{ additionalProperties: false },
);

export type CodemodeSettingsInput = Static<typeof codemodeSettingsSchema>;

export interface CodemodeSettings {
	readonly languages: {
		readonly py: boolean;
		readonly js: boolean;
		readonly rb: boolean;
		readonly jl: boolean;
	};
	readonly cellTimeoutSeconds: number;
	readonly parallelPoolWidth: number;
}

export interface LoadCodemodeSettingsOptions {
	readonly cwd?: string;
	readonly homeDir?: string;
}

export interface LoadedCodemodeSettings {
	readonly settings: CodemodeSettings;
	readonly source: string | null;
	readonly warnings: readonly string[];
}

// OMP settings-schema.ts:3211-3299 has language/path settings only; eval.ts:427
// defaults timeout to 30s, and codemode pins concurrency-bridge.ts:30 width to 4.
export const defaultCodemodeSettings: CodemodeSettings = {
	languages: {
		py: true,
		js: true,
		rb: false,
		jl: false,
	},
	cellTimeoutSeconds: 30,
	parallelPoolWidth: 4,
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
		return {
			settings: defaultCodemodeSettings,
			source: path,
			warnings: [`Invalid JSON in ${path}: ${errorMessage(error)}. Falling back to codemode defaults.`],
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

function mergeSettings(input: CodemodeSettingsInput): CodemodeSettings {
	return {
		languages: {
			py: input.languages?.py ?? defaultCodemodeSettings.languages.py,
			js: input.languages?.js ?? defaultCodemodeSettings.languages.js,
			rb: input.languages?.rb ?? defaultCodemodeSettings.languages.rb,
			jl: input.languages?.jl ?? defaultCodemodeSettings.languages.jl,
		},
		cellTimeoutSeconds: input.cellTimeoutSeconds ?? defaultCodemodeSettings.cellTimeoutSeconds,
		parallelPoolWidth: input.parallelPoolWidth ?? defaultCodemodeSettings.parallelPoolWidth,
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

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
