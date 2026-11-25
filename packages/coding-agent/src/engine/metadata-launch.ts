import {
	type EngineCommandFlag,
	type EngineCommandMetadata,
	type EngineCommandPositional,
	flag,
	input,
	positional,
	PRESENTER_FLAGS,
	requiredFlag,
	SETUP_FLAGS,
} from "./metadata-flags.ts";

const SESSION_FLAGS: readonly EngineCommandFlag[] = [
	flag(["--continue", "-c"], false, input("session.continue", true)),
	flag(["--session"], true, input("session.path")),
	flag(["--session-id"], true, input("session.id")),
	flag(["--fork"], true, input("session.fork")),
	flag(["--rebind"], true, input("session.rebind")),
	flag(["--no-session"], false, input("session.ephemeral", true)),
	flag(["--session-dir"], true, input("session.dir")),
	flag(["--spawned-by"], true, input("session.spawned_by", undefined, "json")),
	flag(["--name", "-n"], true, input("session.name")),
];

const INPUT_POSITIONALS: readonly EngineCommandPositional[] = [
	positional("file", "input.files", true, { variadic: true, prefix: "@" }),
	positional("message", "input.messages", true, { variadic: true }),
];
const STDIN_FLAG = flag(["-"], false, input("input.stdin", true));
const GATED_FLAGS = [flag(["--grok-neo"], false, input("gated.grok_neo", true))];
const API_KEY_FLAG = flag(["--api-key"], true, { kind: "handle", field: "api_key" });

const COMMON_FLAGS = [...SESSION_FLAGS, ...SETUP_FLAGS, API_KEY_FLAG];

/** The five launch operations (design 6.9): each starts an engine process with the parts of `LaunchOptions` it admits. */
export const LAUNCH_COMMANDS: readonly EngineCommandMetadata[] = [
	{
		call: "launch.interactive",
		argv: [],
		positionals: INPUT_POSITIONALS,
		flags: [
			...COMMON_FLAGS,
			STDIN_FLAG,
			...GATED_FLAGS,
			flag(["--tui-mode"], true, input("tui_mode")),
			flag(["--verbose"], false, input("verbose", true)),
			flag(["--attach"], true, input("attach.socket")),
			flag(["--resume", "-r"], false, { kind: "render" }),
		],
	},
	{
		call: "launch.print",
		argv: [],
		positionals: INPUT_POSITIONALS,
		flags: [
			requiredFlag(["--print", "-p"], false, { kind: "selector" }),
			...COMMON_FLAGS,
			STDIN_FLAG,
			...GATED_FLAGS,
			flag(["--mode"], true, input("mode")),
		],
	},
	{
		call: "launch.rpc",
		argv: [],
		positionals: [],
		flags: [
			requiredFlag(["--mode"], true, { kind: "selector", value: "rpc" }),
			...COMMON_FLAGS,
			...GATED_FLAGS,
			flag(["--listen"], true, input("listen")),
			flag(["--multi-session"], false, input("multi_session", true)),
			...PRESENTER_FLAGS,
		],
	},
	{
		call: "launch.hand",
		argv: [],
		positionals: [],
		flags: [requiredFlag(["--hand"], false, { kind: "selector" }), ...COMMON_FLAGS],
	},
	{
		call: "launch.headless",
		argv: [],
		positionals: [],
		flags: [
			requiredFlag(["--headless"], false, { kind: "selector" }),
			...COMMON_FLAGS,
			flag(["--listen"], true, input("listen")),
		],
	},
];
