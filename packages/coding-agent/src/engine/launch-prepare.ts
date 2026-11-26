import { Readable } from "node:stream";
import { Errors } from "typebox/value";
import { isGrokNeoEnabled } from "../cli/grok-neo-gate.ts";
import { sessionFlagRefusal } from "../cli/session-flag-refusal.ts";
import { resolveToolRuntime } from "../cli/tool-runtime.ts";
import type { Args } from "../cli/args.ts";
import { commandOf, launchArgv, parseLaunchArgv } from "./launch-argv.ts";
import { type LaunchMode, type LaunchOptions, LaunchOptionsSchema } from "./launch-options.ts";
import { type EngineError, engineError } from "./result.ts";

export type LaunchCode = "invalid_input" | "launch_failed" | "launch_key_failed" | "launch_key_unsupported";

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

/** The top-level option fields a mode admits, read from its command metadata (the one flag-to-field table). */
function admittedFields(mode: LaunchMode): ReadonlySet<string> {
	const command = commandOf(mode);
	const fields = command.flags.flatMap((entry) =>
		entry.mapping.kind === "input" || entry.mapping.kind === "handle"
			? [entry.mapping.field.split(".")[0] ?? ""]
			: [],
	);
	const positionals = command.positionals.map((entry) => entry.field.split(".")[0] ?? "");
	return new Set([...fields, ...positionals]);
}

/** A field the selected mode does not admit is refused here, not left to whatever the parser makes of it. */
function inapplicableField(mode: LaunchMode, options: LaunchOptions): string | undefined {
	const admitted = admittedFields(mode);
	const field = Object.keys(options).find((key) => Reflect.get(options, key) !== undefined && !admitted.has(key));
	return field === undefined ? undefined : `launch.${mode} does not take ${field}`;
}

/** The parser reads a positional that begins with `@` as a file, even after `--`, so such a message cannot be sent as text. */
function unrepresentableMessage(options: LaunchOptions): string | undefined {
	const index = (options.input?.messages ?? []).findIndex((message) => message.startsWith("@"));
	return index === -1
		? undefined
		: `input.messages[${index}] begins with @, which the command line reads as a file; pass it in input.files or rephrase it`;
}

/** The mode the parsed invocation actually selects. */
function parsedMode(args: Args): LaunchMode {
	if (args.print === true) return "print";
	// The parser runs hand and headless over the rpc mode, so they are read before it.
	if (args.hand === true) return "hand";
	if (args.headless === true) return "headless";
	if (args.mode === "rpc") return "rpc";
	return "interactive";
}

/**
 * Every refusal a launch has today, answered before anything starts: the option shape, then the parser's own
 * refusals over the argv the options produce, then the checks `main()` applies before opening a session.
 */
export function prepareLaunch(mode: LaunchMode, options: LaunchOptions): PreparedLaunch | EngineError<LaunchCode> {
	const shape = shapeRefusal(options);
	if (shape !== undefined) return engineError("invalid_input", shape);
	const inapplicable = inapplicableField(mode, options);
	if (inapplicable !== undefined) return engineError("invalid_input", inapplicable);
	const message = unrepresentableMessage(options);
	if (message !== undefined) return engineError("invalid_input", message);
	if (mode === "print" && options.input === undefined) return engineError("invalid_input", "launch.print needs input");
	if (options.gated?.grok_neo === true && !isGrokNeoEnabled())
		return engineError("invalid_input", "gated.grok_neo is not available while its feature gate is off");
	if (options.attach !== undefined && options.session !== undefined)
		return engineError("invalid_input", "attach names its own session; omit session");
	const argv = launchArgv(mode, mode === "print" ? { ...options, mode: options.mode ?? "text" } : options);
	const parsed = parseLaunchArgv(argv);
	if ("refusal" in parsed) return engineError("invalid_input", parsed.refusal);
	if (parsedMode(parsed.args) !== mode)
		return engineError("invalid_input", `the options do not make a launch.${mode}`);
	const session = sessionFlagRefusal(parsed.args);
	if (session !== undefined) return engineError("invalid_input", session);
	const toolRuntime = resolveToolRuntime(parsed.args);
	if (!toolRuntime.ok) return engineError("invalid_input", toolRuntime.message);
	return { argv };
}
