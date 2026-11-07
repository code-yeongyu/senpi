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
import { type ParsedHostArgs, parseHostArgs } from "./host-command-args.ts";
import { emit } from "./host-emit.ts";
import { presenterBootstrapStream } from "../modes/rpc/mcp-presenter-bootstrap.ts";

export { parseHostArgs } from "./host-command-args.ts";

const USAGE = `usage: ${APP_NAME} host <ensure|status|stop|handoff|shard-path|gc> [options]

  ensure      [--launch-spec <file>] [--policy upgrade|fallback|never] [--socket <path>]
  status      [--include-workers] [--all] [--socket <path>]   (--all: every endpoint, ignores --socket)
  stop        [--drain [--instance <id>] [--wait-ms <n>]] [--force] [--expected-generation <json>] [--socket <path>]
  handoff     [--launch-spec <file>] [--socket <path>]
              [--when idle --operation <id> --if-instance <id> --if-generation <n> --target-build <sha256:...>]
              (--when idle: the running host hands over to THIS runtime at its next safe idle point)
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
	try {
		const request = await hostRequest(parsed);
		const presenterBootstrap =
			parsed.presenterBootstrapFd === undefined ? undefined : presenterBootstrapStream(parsed.presenterBootstrapFd);
		const outcome = await runHostRequest(request, {
			keyRoot: parsed.keyRoot,
			presenterBootstrap,
			mcpPresenterEnforcement: parsed.mcpPresenterEnforcement,
		}).finally(() => presenterBootstrap?.destroy());
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
			return {
				action: "stop",
				target,
				drain: parsed.drain,
				force: parsed.force,
				...(parsed.expectedGeneration !== undefined && { expectedGeneration: parsed.expectedGeneration }),
				...(parsed.instanceId !== undefined && { instanceId: parsed.instanceId }),
				...(parsed.waitMs !== undefined && { waitMs: parsed.waitMs }),
			};
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

function assertNever(value: never): never {
	throw new Error(`unreachable host subcommand: ${JSON.stringify(value)}`);
}
