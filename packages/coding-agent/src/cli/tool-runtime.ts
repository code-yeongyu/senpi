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

/**
 * What the tool child already serves, advertised as `placement:<name>` beside `tool_runtime:child` (senpi#3566): each
 * later todo appends the placement it lands, so a client (and the QA driver) can tell which work moved.
 */
export const TOOL_CHILD_PLACEMENTS = ["launch-barrier", "job-policy", "hostcall", "offload", "terminal"] as const;

/** Advertised in both runtimes: `ctx.offload` / `registerChildModule` exist (where they run is the runtime's choice). */
export const OFFLOAD_API_CAPABILITY = "offload_api";

export function toolRuntimeCapabilities(runtime: ToolRuntimeKind): string[] {
	return [
		toolRuntimeCapability(runtime),
		...(runtime === "child" ? TOOL_CHILD_PLACEMENTS.map((name) => `placement:${name}`) : []),
		OFFLOAD_API_CAPABILITY,
	];
}

export function isHostOwnedToolRuntimeCapability(capability: string): boolean {
	return (
		capability.startsWith("tool_runtime:") ||
		capability.startsWith("placement:") ||
		capability === OFFLOAD_API_CAPABILITY
	);
}

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
export const TOOL_RUNTIME_UNSUPPORTED_HOST = "tool_runtime_unsupported_host";

/**
 * Hosts the child runtime cannot serve yet. Windows needs its own containment (Job Objects, the breakaway shim), which
 * lands separately (senpi#3566); until then `child` is refused there, so no half-gated launch path is ever reachable.
 */
export function toolRuntimeHostRefusal(
	runtime: ToolRuntimeKind,
	platform: NodeJS.Platform = process.platform,
	hasFfi: () => boolean = () => process.getBuiltinModule("bun:ffi") !== undefined,
): string | undefined {
	if (runtime !== "child" || platform !== "win32" || hasFfi()) return undefined;
	return `${TOOL_RUNTIME_UNSUPPORTED_HOST}: --tool-runtime child on Windows needs the Bun runtime (bun:ffi holds the tool child in a Job Object); run senpi under Bun or use in-process`;
}

export class ToolRuntimeUnsupportedHostError extends Error {
	readonly code = TOOL_RUNTIME_UNSUPPORTED_HOST;
	constructor(message: string) {
		super(message);
		this.name = "ToolRuntimeUnsupportedHostError";
	}
}

export function resolveToolRuntime(
	parsed: { readonly toolRuntime?: ToolRuntimeKind },
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	hasFfi?: () => boolean,
): ToolRuntimeResolution {
	const resolved = resolveRequestedToolRuntime(parsed, env);
	if (!resolved.ok) return resolved;
	const refusal = toolRuntimeHostRefusal(resolved.value, platform, hasFfi);
	return refusal === undefined ? resolved : { ok: false, message: refusal };
}

function resolveRequestedToolRuntime(
	parsed: { readonly toolRuntime?: ToolRuntimeKind },
	env: NodeJS.ProcessEnv,
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
