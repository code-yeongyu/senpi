/**
 * `senpi host ensure|status|stop|handoff|shard-path|gc` - the one command every client calls to get a daemon.
 * (`gc` removes the state of endpoints whose host is provably gone, never signalling anything.)
 * (`shard-path` alone contacts no host: it answers the shard naming contract, as a JSON line under
 * `--json` and as the bare socket path otherwise.)
 *
 * The contract is machine-first, because every caller is a program: EXACTLY ONE JSON line on stdout
 * and nothing else, an exit code that classifies the outcome without parsing that line, and
 * diagnostics on stderr where they cannot corrupt either.
 *
 *     0  it happened        2  the command line or the launch spec is unusable
 *     1  it failed          3  refused (see `reason`)              4  fallback: no host is better
 *
 * The line is written with a synchronous `write`, then the process exits with the code: a
 * `console.log` to a pipe is asynchronous, and `process.exit` would truncate the one thing the
 * caller is parsing.
 *
 * The launch spec is a FILE PATH and never stdin or an argv blob - the file's owner and mode are
 * what make it trustworthy, and its directory is what extension paths resolve against
 * (`host-launch-spec.ts`). The environment the daemon is spawned with is an allowlist of NAMES
 * (`host-daemon-env.ts`), never this process's whole environment.
 */
import { writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { APP_NAME, getAgentDir } from "../config.ts";
import { envValue } from "../core/brand.ts";
import type { ShardKind } from "../modes/rpc/host-daemon-paths.ts";
import type { HostDecisionPolicy } from "../modes/rpc/host-decision.ts";
import type { IdleHandoverTerms } from "../modes/rpc/host-handover-request.ts";
import {
	DEFAULT_HOST_LAUNCH_SPEC,
	HostLaunchSpecError,
	loadHostLaunchSpec,
	type ResolvedHostLaunchSpec,
} from "../modes/rpc/host-launch-spec.ts";
import {
	HOST_EXIT_ERROR,
	HOST_EXIT_USAGE,
	type HostRequest,
	type HostTarget,
	runHostRequest,
} from "../modes/rpc/host-runner.ts";
import { emit } from "./host-emit.ts";

const SUBCOMMANDS = ["ensure", "status", "stop", "handoff", "shard-path", "gc"] as const;
type HostSubcommand = (typeof SUBCOMMANDS)[number];

const POLICIES = ["upgrade", "fallback", "never"] as const;

const USAGE = `usage: ${APP_NAME} host <ensure|status|stop|handoff|shard-path|gc> [options]

  ensure      [--launch-spec <file>] [--policy upgrade|fallback|never] [--socket <path>]
  status      [--include-workers] [--all] [--socket <path>]   (--all: every endpoint, ignores --socket)
  stop        [--drain] [--force] [--socket <path>]
  handoff     [--launch-spec <file>] [--socket <path>]
              [--when idle --operation <id> --if-instance <id> --if-generation <n> --target-build <sha256:...>]
              (--when idle: the running host hands over to THIS runtime at its next safe idle point)
  shard-path  --kind <p|i> --owner <id> [--root <dir>] [--json]   (no host contact)
  gc          [--agent-dir <dir>] [--json]   (removes provably dead endpoints only; ignores --socket)
  session     <open|close|model|prompt|steer|abort|read|state|list|wait> [...]   (see "senpi host session")

  --json   the answer is one JSON line on stdout (always, except shard-path's bare path)`;

interface ParsedHostArgs {
	readonly subcommand: HostSubcommand;
	readonly specPath?: string;
	readonly policy: HostDecisionPolicy;
	readonly socket?: string;
	readonly includeWorkers: boolean;
	readonly all: boolean;
	readonly drain: boolean;
	readonly force: boolean;
	readonly json: boolean;
	readonly kind?: ShardKind;
	readonly owner?: string;
	readonly root?: string;
	readonly agentDir?: string;
	readonly handover?: IdleHandoverTerms;
}

/**
 * Runs one `host` invocation and returns the exit code it means, having written its single JSON
 * line. Exported for the launchers that drive the same surface without a shell.
 */
export async function runHostCommand(args: readonly string[]): Promise<number> {
	const parsed = parseHostArgs(args);
	if (typeof parsed === "string") {
		process.stderr.write(`${parsed}\n${USAGE}\n`);
		return HOST_EXIT_USAGE;
	}
	try {
		const outcome = await runHostRequest(await hostRequest(parsed));
		if (parsed.subcommand === "shard-path" && !parsed.json) writeSync(1, `${String(outcome.payload.socket)}\n`);
		else emit(outcome.payload);
		return outcome.exitCode;
	} catch (error: unknown) {
		if (error instanceof HostLaunchSpecError) {
			emit({ action: "error", reason: error.reason, detail: error.detail });
			return HOST_EXIT_USAGE;
		}
		emit({ action: "error", reason: "host_error", detail: error instanceof Error ? error.message : String(error) });
		return HOST_EXIT_ERROR;
	}
}

async function hostRequest(parsed: ParsedHostArgs): Promise<HostRequest> {
	const agentDir = getAgentDir();
	const target: HostTarget = { socket: resolveHostSocket(parsed.socket, agentDir), agentDir };
	switch (parsed.subcommand) {
		case "ensure":
			return { action: "ensure", target, spec: await launchSpec(parsed.specPath), policy: parsed.policy };
		case "status":
			return { action: "status", target, includeWorkers: parsed.includeWorkers, all: parsed.all };
		case "stop":
			return { action: "stop", target, drain: parsed.drain, force: parsed.force };
		case "handoff":
			return {
				action: "handoff",
				target,
				spec: await launchSpec(parsed.specPath),
				...(parsed.handover !== undefined && { handover: parsed.handover }),
			};
		case "shard-path":
			return {
				action: "shard_path",
				kind: parsed.kind ?? "p",
				owner: parsed.owner ?? "",
				root: resolve(parsed.root ?? join(agentDir, "rpc", "shards")),
			};
		case "gc":
			return { action: "gc", agentDir: resolve(parsed.agentDir ?? agentDir) };
		default:
			return assertNever(parsed.subcommand);
	}
}

function launchSpec(specPath: string | undefined): Promise<ResolvedHostLaunchSpec> | ResolvedHostLaunchSpec {
	return specPath === undefined ? DEFAULT_HOST_LAUNCH_SPEC : loadHostLaunchSpec(specPath);
}

/** The endpoint this client would reach: the one it was given, the branded override, or the default. */
export function resolveHostSocket(explicit: string | undefined, agentDir: string): string {
	return explicit ?? envValue("RPC_SOCKET") ?? resolve(agentDir, "rpc", "rpc.sock");
}

/** Parses the command line, or answers with the message that says why it could not. */
export function parseHostArgs(args: readonly string[]): ParsedHostArgs | string {
	const [subcommand, ...rest] = args;
	if (subcommand === undefined || !isSubcommand(subcommand)) {
		return `Error: unknown host command "${subcommand ?? ""}".`;
	}
	let specPath: string | undefined;
	let policy: HostDecisionPolicy = "upgrade";
	let socket: string | undefined;
	let includeWorkers = false;
	let all = false;
	let drain = false;
	let force = false;
	let json = false;
	let kind: ShardKind | undefined;
	let owner: string | undefined;
	let root: string | undefined;
	let agentDir: string | undefined;
	const handover: Record<string, string> = {};
	for (let index = 0; index < rest.length; index++) {
		const flag = rest[index];
		const value = rest[index + 1];
		if (flag === "--json") {
			json = true;
		} else if (flag === "--include-workers") {
			includeWorkers = true;
		} else if (flag === "--all" && subcommand === "status") {
			all = true;
		} else if (flag === "--kind" && subcommand === "shard-path" && (value === "p" || value === "i")) {
			kind = value;
			index++;
		} else if (flag === "--owner" && subcommand === "shard-path" && value !== undefined) {
			owner = value;
			index++;
		} else if (flag === "--root" && subcommand === "shard-path" && value !== undefined) {
			root = value;
			index++;
		} else if (flag === "--agent-dir" && subcommand === "gc" && value !== undefined) {
			agentDir = value;
			index++;
		} else if (subcommand === "handoff" && value !== undefined && HANDOVER_FLAGS.has(flag ?? "")) {
			handover[flag ?? ""] = value;
			index++;
		} else if (flag === "--drain") {
			drain = true;
		} else if (flag === "--force") {
			force = true;
		} else if (flag === "--launch-spec" && value !== undefined) {
			specPath = value;
			index++;
		} else if (flag === "--socket" && value !== undefined) {
			socket = value;
			index++;
		} else if (flag === "--policy" && value !== undefined && isPolicy(value)) {
			policy = value;
			index++;
		} else {
			return `Error: unknown option "${flag}" for "${APP_NAME} host ${subcommand}".`;
		}
	}
	if (subcommand === "shard-path" && (kind === undefined || owner === undefined)) {
		return `Error: "${APP_NAME} host shard-path" needs --kind <p|i> and --owner <id>.`;
	}
	const terms = Object.keys(handover).length === 0 ? undefined : handoverTerms(handover);
	if (typeof terms === "string") return terms;
	return {
		subcommand,
		...(specPath !== undefined && { specPath }),
		policy,
		...(socket !== undefined && { socket }),
		includeWorkers,
		all,
		drain,
		force,
		json,
		...(kind !== undefined && { kind }),
		...(owner !== undefined && { owner }),
		...(root !== undefined && { root }),
		...(agentDir !== undefined && { agentDir }),
		...(terms !== undefined && { handover: terms }),
	};
}

const HANDOVER_FLAGS = new Set(["--when", "--operation", "--if-instance", "--if-generation", "--target-build"]);

/** The conditional handover's terms: all five flags together, or a usage error naming what is wrong. */
function handoverTerms(flags: Readonly<Record<string, string>>): IdleHandoverTerms | string {
	const when = flags["--when"];
	const operationId = flags["--operation"];
	const ifInstanceId = flags["--if-instance"];
	const generation = flags["--if-generation"];
	const targetRuntimeBuildId = flags["--target-build"];
	if (when !== "idle") return `Error: "${APP_NAME} host handoff" supports only --when idle.`;
	if (!operationId || !ifInstanceId || !generation || !targetRuntimeBuildId) {
		return `Error: "${APP_NAME} host handoff --when idle" needs --operation, --if-instance, --if-generation and --target-build.`;
	}
	const ifGeneration = Number(generation);
	if (!/^\d+$/.test(generation) || !Number.isSafeInteger(ifGeneration)) {
		return `Error: --if-generation must be a non-negative integer.`;
	}
	return { operationId, ifInstanceId, ifGeneration, targetRuntimeBuildId };
}

function isSubcommand(value: string): value is HostSubcommand {
	return SUBCOMMANDS.includes(value as HostSubcommand);
}

function isPolicy(value: string): value is HostDecisionPolicy {
	return POLICIES.includes(value as HostDecisionPolicy);
}

function assertNever(value: never): never {
	throw new Error(`unreachable host subcommand: ${JSON.stringify(value)}`);
}
