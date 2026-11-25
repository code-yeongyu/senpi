import { Readable } from "node:stream";
import { Errors } from "typebox/value";
import { isGrokNeoEnabled } from "../cli/grok-neo-gate.ts";
import { sessionFlagRefusal } from "../cli/session-flag-refusal.ts";
import { resolveToolRuntime } from "../cli/tool-runtime.ts";
import { launchArgv, parseLaunchArgv } from "./launch-argv.ts";
import { type LaunchMode, type LaunchOptions, LaunchOptionsSchema } from "./launch-options.ts";
import { type EngineError, engineError } from "./result.ts";

export type LaunchCode = "invalid_input" | "launch_failed" | "launch_key_failed";

export interface PreparedLaunch {
	readonly argv: readonly string[];
}

function isKeyHandle(value: unknown): boolean {
	return value instanceof Readable || value instanceof ReadableStream;
}

function shapeRefusal(options: LaunchOptions): string | undefined {
	if (typeof options !== "object" || options === null || Array.isArray(options)) return "options must be an object";
	const { api_key: key, ...rest } = options;
	if (key !== undefined && !isKeyHandle(key)) return "api_key must be a readable handle";
	const first = [...Errors(LaunchOptionsSchema, rest)][0];
	if (first === undefined) return undefined;
	const where = first.instancePath === "" ? "options" : first.instancePath.slice(1).replaceAll("/", ".");
	return `${where}: ${first.message}`;
}

/**
 * Every refusal a launch has today, answered before anything starts: the option shape, then the parser's own
 * refusals over the argv the options produce, then the checks `main()` applies before opening a session.
 */
export function prepareLaunch(mode: LaunchMode, options: LaunchOptions): PreparedLaunch | EngineError<LaunchCode> {
	const shape = shapeRefusal(options);
	if (shape !== undefined) return engineError("invalid_input", shape);
	if (mode === "print" && options.input === undefined) return engineError("invalid_input", "launch.print needs input");
	if (options.gated?.grok_neo === true && !isGrokNeoEnabled())
		return engineError("invalid_input", "gated.grok_neo is not available while its feature gate is off");
	if (options.attach !== undefined && options.session !== undefined)
		return engineError("invalid_input", "attach names its own session; omit session");
	const argv = launchArgv(mode, mode === "print" ? { ...options, mode: options.mode ?? "text" } : options);
	const parsed = parseLaunchArgv(argv);
	if ("refusal" in parsed) return engineError("invalid_input", parsed.refusal);
	const session = sessionFlagRefusal(parsed.args);
	if (session !== undefined) return engineError("invalid_input", session);
	const toolRuntime = resolveToolRuntime(parsed.args);
	if (!toolRuntime.ok) return engineError("invalid_input", toolRuntime.message);
	return { argv };
}
