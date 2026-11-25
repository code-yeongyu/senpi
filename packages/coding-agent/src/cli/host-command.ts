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
import { APP_NAME } from "../config.ts";
import { type HostOperation, runHostOperation } from "../engine/host.ts";
import {
	HOST_EXIT_ERROR,
	HOST_EXIT_FALLBACK,
	HOST_EXIT_OK,
	HOST_EXIT_REFUSED,
	HOST_EXIT_USAGE,
} from "../modes/rpc/host-runner.ts";
import { type ParsedHostArgs, parseHostArgs } from "./host-command-args.ts";
import { emit } from "./host-emit.ts";

export { parseHostArgs } from "./host-command-args.ts";

const USAGE = `usage: ${APP_NAME} host <ensure|status|stop|handoff|shard-path|gc> [options]

  ensure      [--launch-spec <file>] [--policy upgrade|fallback|never] [--socket <path>]
  status      [--include-workers] [--all] [--socket <path>]   (--all: every endpoint, ignores --socket)
  stop        [--drain [--instance <id>] [--wait-ms <n>]] [--force] [--expected-generation <json>] [--socket <path>]
  handoff     [--launch-spec <file>] [--socket <path>] [--allow-downgrade]
              [--when idle --operation <id> --if-instance <id> --if-generation <n> --target-build <sha256:...>]
              (--when idle: the running host hands over to THIS runtime at its next safe idle point)
              (a host on a newer engine is refused older_engine unless --allow-downgrade)
  shard-path  --kind <p|i> --owner <id> [--root <dir>] [--json]   (no host contact)
  gc          [--agent-dir <dir>] [--json]   (removes provably dead endpoints only; ignores --socket)
  session     <open|close|model|prompt|steer|abort|read|state|list|wait> [...]   (see "senpi host session")

  --rpc-key-root <dir>   endpoint credentials only; keeps this client's profile
  --mcp-presenter-enforcement   ensure/handoff deployment opt-in; default off for a new host
  --mcp-presenter-fd 4   ensure/handoff private enrollment channel; never enrolls on reuse
  --json   the answer is one JSON line on stdout (always, except shard-path's bare path)`;

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
	const result = await runHostOperation(hostOperation(parsed), {
		...(parsed.socket !== undefined && { socket: parsed.socket }),
		...(parsed.keyRoot !== undefined && { keyRoot: parsed.keyRoot }),
		...(parsed.presenterBootstrapFd !== undefined && { presenterBootstrapFd: parsed.presenterBootstrapFd }),
		...(parsed.mcpPresenterEnforcement !== undefined && { mcpPresenterEnforcement: parsed.mcpPresenterEnforcement }),
	});
	const payload = result.kind === "ok" ? result.value.payload : result.error.details?.payload;
	const line = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
	if (parsed.subcommand === "shard-path" && !parsed.json && result.kind === "ok")
		writeSync(1, `${String(line.socket)}\n`);
	else emit(line);
	return exitCode(result);
}

function exitCode(result: Awaited<ReturnType<typeof runHostOperation>>): number {
	if (result.kind === "ok") return result.value.outcome === "fallback" ? HOST_EXIT_FALLBACK : HOST_EXIT_OK;
	switch (result.error.code) {
		case "refused":
			return HOST_EXIT_REFUSED;
		case "usage":
			return HOST_EXIT_USAGE;
		case "failed":
			return HOST_EXIT_ERROR;
	}
}

function hostOperation(parsed: ParsedHostArgs): HostOperation {
	switch (parsed.subcommand) {
		case "ensure":
			return {
				operation: "ensure",
				policy: parsed.policy,
				...(parsed.specPath !== undefined && { launch_spec: parsed.specPath }),
			};
		case "status":
			return { operation: "status", include_workers: parsed.includeWorkers, all: parsed.all };
		case "stop":
			return {
				operation: "stop",
				drain: parsed.drain,
				force: parsed.force,
				...(parsed.expectedGeneration !== undefined && { expected_generation: parsed.expectedGeneration }),
				...(parsed.instanceId !== undefined && { instance: parsed.instanceId }),
				...(parsed.waitMs !== undefined && { wait_ms: parsed.waitMs }),
			};
		case "handoff":
			return {
				operation: "handoff",
				...(parsed.specPath !== undefined && { launch_spec: parsed.specPath }),
				...(parsed.allowDowngrade === true && { allow_downgrade: true }),
				...(parsed.handover !== undefined && {
					when: {
						idle: {
							operation: parsed.handover.operationId,
							if_instance: parsed.handover.ifInstanceId,
							if_generation: parsed.handover.ifGeneration,
							target_build: parsed.handover.targetRuntimeBuildId,
						},
					},
				}),
			};
		case "shard-path":
			return {
				operation: "shard_path",
				kind: parsed.kind ?? "p",
				owner: parsed.owner ?? "",
				...(parsed.root !== undefined && { root: parsed.root }),
			};
		case "gc":
			return { operation: "gc", ...(parsed.agentDir !== undefined && { agent_dir: parsed.agentDir }) };
		default: {
			const exhaustive: never = parsed.subcommand;
			return exhaustive;
		}
	}
}
