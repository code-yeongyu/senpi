import type { Static } from "typebox";
import { Type } from "typebox";
import { runtimeNameOf } from "../kernels/js/runtime-name.ts";

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

/** The host as the JavaScript kernel's default isolation sees it: what its own executable is. */
export interface JsIsolationHost {
	/** "bun" or "node" when the host's executable is that runtime; undefined for a compiled binary. */
	readonly executable: "bun" | "node" | undefined;
}

export function currentJsIsolationHost(execPath: string = process.execPath): JsIsolationHost {
	return { executable: runtimeNameOf(execPath) };
}

/**
 * Without a setting, a host whose executable is bun runs the kernel in its own process: a Bun 1.4.4 Worker thread can
 * corrupt the JavaScriptCore heap and take the whole host down with it (SIGBUS/SIGTRAP, the open upstream class behind
 * omo#12369), and a kernel process cannot. A Node.js host keeps the worker thread, and so does a compiled binary: its
 * executable cannot run process-entry.js, so process mode there needs a bun or node on PATH, which only an explicit
 * setting asks for.
 */
export function defaultJsIsolation(host: JsIsolationHost): JsIsolation {
	return host.executable === "bun" ? "process" : "worker";
}

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

/** The environment wins over the file, the file over the host default; an unknown value is ignored. */
export function resolveJsIsolation(
	settings: CodemodeFeatureSettings,
	env: Environment = process.env,
	host: JsIsolationHost = currentJsIsolationHost(),
): JsIsolation {
	const fromEnv = env[JS_ISOLATION_ENVIRONMENT_FLAG];
	if (fromEnv === "worker" || fromEnv === "process") return fromEnv;
	return settings.isolation?.js ?? defaultJsIsolation(host);
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
