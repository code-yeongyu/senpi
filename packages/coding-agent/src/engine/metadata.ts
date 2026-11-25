/**
 * The leaf commands the omo launcher forwards to this engine, their flags, and what each flag fills
 * (senpi#7450), so a downstream registry enumerates them from the engine and not from a hand-kept list.
 */

import {
	type EngineCommandMetadata,
	flag,
	hostFlags,
	input,
	LOCAL_FLAG,
	positional,
	PRESENTER_FLAGS,
	requiredFlag,
	SETUP_FLAGS,
	TRUST_FLAGS,
} from "./metadata-flags.ts";

export {
	type EngineCommandFlag,
	type EngineCommandMetadata,
	type EngineCommandPositional,
	type EngineFlagMapping,
	GATED_SLICE,
} from "./metadata-flags.ts";

export const ENGINE_COMMANDS: readonly EngineCommandMetadata[] = [
	{
		call: "packages.install",
		argv: ["install"],
		positionals: [positional("source", "source")],
		flags: [LOCAL_FLAG, ...TRUST_FLAGS],
	},
	{
		call: "packages.remove",
		argv: ["remove"],
		aliases: [["uninstall"]],
		positionals: [positional("source", "source")],
		flags: [LOCAL_FLAG, ...TRUST_FLAGS],
	},
	{ call: "packages.list", argv: ["list"], positionals: [], flags: TRUST_FLAGS },
	{
		call: "packages.update",
		argv: ["update"],
		positionals: [],
		flags: [requiredFlag(["--extensions"], false, { kind: "selector" }), ...TRUST_FLAGS],
	},
	{
		call: "packages.update",
		argv: ["update"],
		positionals: [],
		flags: [requiredFlag(["--extension"], true, input("source")), ...TRUST_FLAGS],
	},
	{ call: "packages.update", argv: ["update"], positionals: [positional("source", "source")], flags: TRUST_FLAGS },
	{
		call: "models.update",
		argv: ["update"],
		positionals: [],
		flags: [requiredFlag(["--models"], false, { kind: "selector" })],
	},
	{
		call: "models.discover",
		argv: ["models", "discover"],
		positionals: [positional("provider", "provider")],
		flags: [],
	},
	{
		call: "models.list",
		argv: [],
		positionals: [],
		flags: [requiredFlag(["--list-models"], true, input("pattern")), ...SETUP_FLAGS],
	},
	{
		call: "config.agentDir",
		argv: ["config", "agent-dir"],
		positionals: [],
		flags: [requiredFlag(["--json"], false, { kind: "render" })],
	},
	{ call: "config.resources", argv: ["config"], positionals: [], flags: [LOCAL_FLAG, ...TRUST_FLAGS] },
	{
		call: "config.setResource",
		argv: ["config"],
		via: "tui",
		positionals: [],
		flags: [LOCAL_FLAG, ...TRUST_FLAGS],
	},
	{
		call: "schedule.list",
		argv: ["schedule", "list"],
		positionals: [],
		flags: [flag(["--json"], false, { kind: "render" })],
	},
	{ call: "schedule.cancel", argv: ["schedule", "cancel"], positionals: [positional("id", "id")], flags: [] },
	{
		call: "schedule.run",
		argv: ["schedule", "run"],
		positionals: [],
		flags: [
			flag(["--watch"], false, input("watch", true)),
			flag(["--exec"], true, input("exec")),
			flag(["--poll-seconds"], true, input("poll_seconds")),
			flag(["--timeout-seconds"], true, input("timeout_seconds")),
			flag(["--concurrency"], true, input("concurrency")),
		],
	},
	{
		call: "sessionOfPid",
		argv: ["session-of-pid"],
		positionals: [positional("pid", "pid")],
		flags: [requiredFlag(["--json"], false, { kind: "render" })],
	},
	{
		call: "sessions.exportHtml",
		argv: [],
		positionals: [positional("out", "out", true)],
		flags: [requiredFlag(["--export"], true, input("session"))],
	},
	{
		call: "promptSizes",
		argv: [],
		positionals: [],
		flags: [requiredFlag(["--print-prompt-sizes"], false, { kind: "selector" }), ...SETUP_FLAGS],
	},
	{ call: "tips", argv: [], positionals: [], flags: [requiredFlag(["--list-tips"], false, { kind: "selector" })] },
	{
		call: "host.ensure",
		argv: ["host", "ensure"],
		positionals: [],
		flags: hostFlags([
			flag(["--launch-spec"], true, input("launch_spec")),
			flag(["--policy"], true, input("policy")),
			...PRESENTER_FLAGS,
		]),
	},
	{
		call: "host.status",
		argv: ["host", "status"],
		positionals: [],
		flags: hostFlags([
			flag(["--include-workers"], false, input("include_workers", true)),
			flag(["--all"], false, input("all", true)),
		]),
	},
	{
		call: "host.stop",
		argv: ["host", "stop"],
		positionals: [],
		flags: hostFlags([
			flag(["--drain"], false, input("drain", true)),
			flag(["--instance"], true, input("instance")),
			flag(["--wait-ms"], true, input("wait_ms")),
			flag(["--force"], false, input("force", true)),
			flag(["--expected-generation"], true, input("expected_generation")),
		]),
	},
	{
		call: "host.handoff",
		argv: ["host", "handoff"],
		positionals: [],
		flags: hostFlags([
			flag(["--launch-spec"], true, input("launch_spec")),
			flag(["--allow-downgrade"], false, input("allow_downgrade", true)),
			flag(["--when"], true, input("when")),
			flag(["--operation"], true, input("when.idle.operation")),
			flag(["--if-instance"], true, input("when.idle.if_instance")),
			flag(["--if-generation"], true, input("when.idle.if_generation")),
			flag(["--target-build"], true, input("when.idle.target_build")),
			...PRESENTER_FLAGS,
		]),
	},
	{
		call: "host.gc",
		argv: ["host", "gc"],
		positionals: [],
		flags: hostFlags([flag(["--agent-dir"], true, input("agent_dir"))]),
	},
	{
		call: "host.shardPath",
		argv: ["host", "shard-path"],
		positionals: [],
		flags: hostFlags([
			requiredFlag(["--kind"], true, input("kind")),
			requiredFlag(["--owner"], true, input("owner")),
			flag(["--root"], true, input("root")),
		]),
	},
];
