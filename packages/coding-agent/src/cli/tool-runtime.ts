/**
 * `--tool-runtime in-process|child`: where a session's heavy tool work runs (senpi#3566).
 *
 * `in-process` runs every tool on the host's own event loop, as senpi always has. `child` moves heavy
 * tool work into one tool child per session. The flag is plumbing only until the child runtime lands;
 * the resolved value is advertised as `tool_runtime:<value>` in `get_protocol_info`.
 */
import { brandEnvNames, envValue } from "../core/brand.ts";

const TOOL_RUNTIMES = ["in-process", "child"] as const;

export type ToolRuntimeKind = (typeof TOOL_RUNTIMES)[number];

export function isToolRuntimeKind(value: string): value is ToolRuntimeKind {
	return TOOL_RUNTIMES.some((kind) => kind === value);
}

const TOOL_RUNTIME_ENV_SUFFIX = "TOOL_RUNTIME";

export function toolRuntimeCapability(runtime: ToolRuntimeKind): `tool_runtime:${ToolRuntimeKind}` {
	return `tool_runtime:${runtime}`;
}

export type ToolRuntimeResolution =
	| { readonly ok: true; readonly value: ToolRuntimeKind }
	| { readonly ok: false; readonly message: string };

/**
 * Tool runtime of this process: `--tool-runtime` wins, then `SENPI_TOOL_RUNTIME`, then `in-process`.
 * An env value outside the two kinds is a startup error, the same as an unknown flag value: a typo
 * must never silently select the other runtime.
 */
export function resolveToolRuntime(
	parsed: { readonly toolRuntime?: ToolRuntimeKind },
	env: NodeJS.ProcessEnv = process.env,
): ToolRuntimeResolution {
	if (parsed.toolRuntime !== undefined) return { ok: true, value: parsed.toolRuntime };
	const fromEnv = envValue(TOOL_RUNTIME_ENV_SUFFIX, env);
	if (fromEnv === undefined || fromEnv === "") return { ok: true, value: "in-process" };
	if (isToolRuntimeKind(fromEnv)) return { ok: true, value: fromEnv };
	// Name the variable that actually carried the value: a legacy prefix is read too (as for every brand setting).
	const name =
		brandEnvNames(TOOL_RUNTIME_ENV_SUFFIX).find((candidate) => env[candidate] !== undefined) ??
		TOOL_RUNTIME_ENV_SUFFIX;
	return {
		ok: false,
		message: `${name} (--tool-runtime) must be in-process or child, got ${JSON.stringify(fromEnv)}`,
	};
}
