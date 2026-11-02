import type { Static } from "typebox";
import { Type } from "typebox";

type Environment = Readonly<Record<string, string | undefined>>;

export const JS_ISOLATION_ENVIRONMENT_FLAG = "SENPI_CODEMODE_JS_ISOLATION";
export const SANDBOX_MEMORY_ENVIRONMENT_FLAG = "SENPI_CODEMODE_SANDBOX_MEMORY_MB";

export const featureSettingsProperties = {
	environments: Type.Optional(
		Type.Object(
			{
				managedRoot: Type.Optional(Type.String({ minLength: 1 })),
				autoProvision: Type.Optional(Type.Boolean()),
				js: Type.Optional(
					Type.Object(
						{ installer: Type.Union([Type.Literal("auto"), Type.Literal("bun"), Type.Literal("npm")]) },
						{ additionalProperties: false },
					),
				),
				py: Type.Optional(Type.Object({ installer: Type.Literal("pip") }, { additionalProperties: false })),
			},
			{ additionalProperties: false },
		),
	),
	isolation: Type.Optional(
		Type.Object(
			{ js: Type.Optional(Type.Union([Type.Literal("worker"), Type.Literal("process")])) },
			{ additionalProperties: false },
		),
	),
	sandbox: Type.Optional(
		Type.Object(
			{
				enabled: Type.Optional(Type.Boolean()),
				memoryMb: Type.Optional(Type.Integer({ minimum: 1 })),
				timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
			},
			{ additionalProperties: false },
		),
	),
	prompt: Type.Optional(
		Type.Object({ advertiseHelpers: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
	),
	kernelTools: Type.Optional(Type.Object({ enabled: Type.Optional(Type.Boolean()) }, { additionalProperties: false })),
};

const featureSettingsSchema = Type.Object(featureSettingsProperties);

export type CodemodeFeatureSettings = Static<typeof featureSettingsSchema>;

export type JsIsolation = "worker" | "process";

export interface ResolvedSandbox {
	readonly enabled: boolean;
	readonly memoryMb: number;
	readonly timeoutSeconds: number;
}

export interface ResolvedEnvironments {
	readonly managedRoot?: string;
	readonly autoProvision: boolean;
	readonly jsInstaller: "auto" | "bun" | "npm";
	readonly pyInstaller: "pip";
}

export function pickFeatureSettings(input: CodemodeFeatureSettings): CodemodeFeatureSettings {
	return {
		...(input.environments === undefined ? {} : { environments: input.environments }),
		...(input.isolation === undefined ? {} : { isolation: input.isolation }),
		...(input.sandbox === undefined ? {} : { sandbox: input.sandbox }),
		...(input.prompt === undefined ? {} : { prompt: input.prompt }),
		...(input.kernelTools === undefined ? {} : { kernelTools: input.kernelTools }),
	};
}

/** The environment wins over the file; an unknown value is ignored. Default: today's worker-thread kernel. */
export function resolveJsIsolation(settings: CodemodeFeatureSettings, env: Environment = process.env): JsIsolation {
	const fromEnv = env[JS_ISOLATION_ENVIRONMENT_FLAG];
	if (fromEnv === "worker" || fromEnv === "process") return fromEnv;
	return settings.isolation?.js ?? "worker";
}

/** Off by default; the environment's memory cap wins over the file when it is a positive integer. */
export function resolveSandbox(settings: CodemodeFeatureSettings, env: Environment = process.env): ResolvedSandbox {
	const fromEnv = Number.parseInt(env[SANDBOX_MEMORY_ENVIRONMENT_FLAG] ?? "", 10);
	return {
		enabled: settings.sandbox?.enabled ?? false,
		memoryMb: Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : (settings.sandbox?.memoryMb ?? 64),
		timeoutSeconds: settings.sandbox?.timeoutSeconds ?? 300,
	};
}

export function resolveEnvironments(settings: CodemodeFeatureSettings): ResolvedEnvironments {
	const environments = settings.environments;
	return {
		...(environments?.managedRoot === undefined ? {} : { managedRoot: environments.managedRoot }),
		autoProvision: environments?.autoProvision ?? true,
		jsInstaller: environments?.js?.installer ?? "auto",
		pyInstaller: environments?.py?.installer ?? "pip",
	};
}

export function resolveAdvertiseHelpers(settings: CodemodeFeatureSettings): boolean {
	return settings.prompt?.advertiseHelpers ?? false;
}

export function resolveKernelToolsEnabled(settings: CodemodeFeatureSettings): boolean {
	return settings.kernelTools?.enabled ?? true;
}
