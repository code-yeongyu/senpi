/**
 * One host request, performed: ensure a daemon, report one, stop one, or hand one off.
 *
 * This is the whole behaviour behind `senpi host` - and behind the launchers that call the same
 * entry point in-process - separated from the command line that expresses it. Every request answers
 * with a JSON payload plus the exit code that payload means, so a CLI, a desktop and a task runner
 * report the same outcome with the same vocabulary:
 *
 *     0  the request happened            3  refused: a running host this client may not act on,
 *     4  no host is better than this one     an unreachable socket, or a stop that would end
 *        one (fallback policy)               somebody else's work
 *
 * The refusals are the point. One daemon holds every client's sessions on its endpoint, so a client
 * that cannot get what it wants must SAY so and leave the running host alone (I1) - never stop it,
 * never bind a second host over its socket. `decideHostAction`, `ensureHost`, `stopHost` and
 * `handoffHost` already enforce that; this module only gives their outcomes a machine-readable shape.
 *
 * A terminal control endpoint (`endpoint_kind: "tui"`) is owned by its terminal process and is never
 * ensured, handed off, drained or stopped by a host operator: `ensure`, `handoff` and `stop` against
 * one refuse with `unsupported_endpoint_kind` (exit 3) from disk alone, before any connection.
 */
import { daemonEnvKeys, daemonEnvOverrides, writeDaemonEnvKeys } from "./host-daemon-env.ts";
import { createHostDaemonPaths, type ShardKind, shardKey, shardSocketPathForKey } from "./host-daemon-paths.ts";
import {
	decideHostAction,
	type HostDecisionPolicy,
	HostEnsureRefusedError,
	type HostProtocolInfo,
} from "./host-decision.ts";
import { endpointKindOfSocket } from "./host-endpoints.ts";
import { type EnsuredHost, ensureHost } from "./host-ensure.ts";
import { gcHostEndpoints } from "./host-gc.ts";
import { type HandoffRefusal, handoffHost } from "./host-handoff.ts";
import { type IdleHandoverTerms, idleHandoverOutcome } from "./host-handover-request.ts";
import type { ResolvedHostLaunchSpec } from "./host-launch-spec.ts";
import {
	clientRuntimeBuildId,
	decisionClient,
	HOST_EXIT_OK,
	HOST_EXIT_REFUSED,
	type HostOutcome,
	identityPayload,
	refusal,
} from "./host-outcome.ts";
import { probeProtocolInfo } from "./host-probe.ts";
import { readHostStatus, readSessionCounts } from "./host-status.ts";
import { readAllHostStatus } from "./host-status-all.ts";
import { stopHost } from "./host-stop.ts";

export {
	HOST_EXIT_ERROR,
	HOST_EXIT_FALLBACK,
	HOST_EXIT_OK,
	HOST_EXIT_REFUSED,
	HOST_EXIT_USAGE,
	type HostOutcome,
} from "./host-outcome.ts";

const PROBE_TIMEOUT_MS = 10_000;

/** Which daemon a request is about: the endpoint, and the agent directory holding its state. */
export interface HostTarget {
	readonly socket: string;
	readonly agentDir: string;
}

export type HostRequest =
	| {
			readonly action: "ensure";
			readonly target: HostTarget;
			readonly spec: ResolvedHostLaunchSpec;
			readonly policy: HostDecisionPolicy;
	  }
	| {
			readonly action: "status";
			readonly target: HostTarget;
			readonly includeWorkers: boolean;
			/** Every endpoint under `target.agentDir` (its socket is ignored), read without pruning. */
			readonly all?: boolean;
	  }
	| { readonly action: "stop"; readonly target: HostTarget; readonly drain: boolean; readonly force: boolean }
	| {
			readonly action: "handoff";
			readonly target: HostTarget;
			readonly spec: ResolvedHostLaunchSpec;
			/** The conditional form (`--when idle`): the running host hands over at its next safe idle point. */
			readonly handover?: IdleHandoverTerms;
	  }
	/** Removes endpoint state under `agentDir` only on the three-part evidence (`host-gc.ts`). */
	| { readonly action: "gc"; readonly agentDir: string }
	| { readonly action: "shard_path"; readonly kind: ShardKind; readonly owner: string; readonly root: string };

export async function runHostRequest(request: HostRequest): Promise<HostOutcome> {
	if (request.action === "ensure" || request.action === "handoff" || request.action === "stop") {
		const { socket, agentDir } = request.target;
		if ((await endpointKindOfSocket(socket, agentDir)) === "tui") {
			return refusal("refuse", undefined, { reason: "unsupported_endpoint_kind", socket, endpoint_kind: "tui" });
		}
	}
	switch (request.action) {
		case "ensure":
			return ensureOutcome(request.target, request.spec, request.policy);
		case "status":
			return request.all === true
				? statusAllOutcome(request.target, request.includeWorkers)
				: statusOutcome(request.target, request.includeWorkers);
		case "stop":
			return stopOutcome(request.target, request.drain, request.force);
		case "handoff":
			return request.handover === undefined
				? handoffOutcome(request.target, request.spec)
				: idleHandoverOutcome(request.target, request.spec, request.handover);
		case "shard_path":
			return shardPathOutcome(request.kind, request.owner, request.root);
		case "gc":
			return { exitCode: HOST_EXIT_OK, payload: { ...(await gcHostEndpoints(request.agentDir)) } };
		default:
			return assertNever(request);
	}
}

async function ensureOutcome(
	target: HostTarget,
	spec: ResolvedHostLaunchSpec,
	policy: HostDecisionPolicy,
): Promise<HostOutcome> {
	const before = await probeProtocolInfo(target.socket, PROBE_TIMEOUT_MS);
	if (policy === "fallback") {
		// `fallback` is the caller saying it can live without a host. The decision is made HERE
		// because an ensure always produces a host or fails: it has no fallback answer of its own.
		const decision = decideHostAction(decisionClient(), before, "fallback");
		if (decision.action === "fallback") {
			return refusal("fallback", before, { reason: decision.reason, socket: target.socket });
		}
	}
	let ensured: EnsuredHost;
	try {
		ensured = await ensureHost({
			socket: target.socket,
			agentDir: target.agentDir,
			hostArgs: spec.hostArgs,
			env: daemonEnvOverrides(process.env, spec.env),
			policy: spec.policy,
			upgrade: policy === "upgrade" ? "if-engine-differs" : "never",
		});
	} catch (error: unknown) {
		if (!(error instanceof HostEnsureRefusedError)) throw error;
		return refusal("refuse", before, {
			reason: error.reason,
			socket: target.socket,
			...(error.detail !== undefined && { detail: error.detail }),
		});
	}
	const host = await probeProtocolInfo(target.socket, PROBE_TIMEOUT_MS).finally(ensured.release);
	// Only a spawn grants an environment; a reuse inherited whatever the client that started it did.
	if (!ensured.reused) await recordEnvScope(target, spec);
	return {
		exitCode: HOST_EXIT_OK,
		payload: {
			action: ensureAction(ensured.reused, before, host),
			...identityPayload(target.socket, ensured.pid, host),
			clientRuntimeBuildId: await clientRuntimeBuildId(spec),
			reused: ensured.reused,
		},
	};
}

/**
 * What an ensure DID. A handoff and a fresh start both report `reused: false`, so the instance id is
 * what tells them apart: a handoff replaced the process behind a socket somebody was already serving.
 */
function ensureAction(
	reused: boolean,
	before: HostProtocolInfo | undefined,
	after: HostProtocolInfo | undefined,
): string {
	if (reused) return "reuse";
	return before !== undefined && before.instanceId !== after?.instanceId ? "handoff" : "start";
}

async function statusOutcome(target: HostTarget, includeWorkers: boolean): Promise<HostOutcome> {
	const status = await readHostStatus({ socket: target.socket, agentDir: target.agentDir, includeWorkers });
	return { exitCode: status.reachable ? HOST_EXIT_OK : HOST_EXIT_REFUSED, payload: { ...status } };
}

/** Same exit vocabulary as one socket: 0 while anything answers, 3 when nothing does (or nothing is there). */
async function statusAllOutcome(target: HostTarget, includeWorkers: boolean): Promise<HostOutcome> {
	const endpoints = await readAllHostStatus({ agentDir: target.agentDir, includeWorkers });
	const reachable = endpoints.some((endpoint) => endpoint.reachable);
	return { exitCode: reachable ? HOST_EXIT_OK : HOST_EXIT_REFUSED, payload: { endpoints } };
}

/** The naming contract answered without contacting any host, for a client that mirrors it locally. */
function shardPathOutcome(kind: ShardKind, owner: string, root: string): HostOutcome {
	const key = shardKey(kind, owner);
	return { exitCode: HOST_EXIT_OK, payload: { kind, key, socket: shardSocketPathForKey(root, kind, key) } };
}

/**
 * A hard stop ends every session the daemon holds, including the ones other clients are attached to,
 * so it is gated on the host's own count and refuses with those counts rather than a bare "busy".
 * A DRAIN ends no work - the host stops accepting and leaves when it is empty - so it is never gated.
 */
async function stopOutcome(target: HostTarget, drain: boolean, force: boolean): Promise<HostOutcome> {
	const host = await probeProtocolInfo(target.socket, PROBE_TIMEOUT_MS);
	const sessions = await readSessionCounts(target.socket, true);
	const occupied = sessions.foreign_attached + sessions.foreign_retained > 0;
	if (!drain && !force && occupied) {
		return refusal("refuse", host, { reason: "sessions_live", socket: target.socket, sessions });
	}
	const result = await stopHost({ socket: target.socket, agentDir: target.agentDir, drain, force });
	if (result.action === "refuse") {
		return refusal("refuse", host, { reason: result.reason, socket: target.socket, sessions });
	}
	return {
		exitCode: HOST_EXIT_OK,
		payload: { action: result.action, socket: target.socket, pid: result.pid, sessions },
	};
}

async function handoffOutcome(target: HostTarget, spec: ResolvedHostLaunchSpec): Promise<HostOutcome> {
	const before = await probeProtocolInfo(target.socket, PROBE_TIMEOUT_MS);
	const result = await handoffHost({
		socket: target.socket,
		agentDir: target.agentDir,
		hostArgs: spec.hostArgs,
		env: daemonEnvOverrides(process.env, spec.env),
		policy: spec.policy,
	});
	if (result.action === "refuse") {
		return refusal("refuse", before, {
			reason: upgradeRefusal(result.reason),
			socket: target.socket,
			detail: result.detail ?? result.reason,
			upgradeable: result.upgradeable,
		});
	}
	await recordEnvScope(target, spec);
	const host = await probeProtocolInfo(target.socket, PROBE_TIMEOUT_MS);
	return {
		exitCode: HOST_EXIT_OK,
		payload: {
			action: "handoff",
			...identityPayload(target.socket, result.pid, host),
			clientRuntimeBuildId: await clientRuntimeBuildId(spec),
			reused: false,
		},
	};
}

/**
 * A host that cannot drain and a platform that cannot hand off are one answer to the caller: this
 * build may not replace the running generation. The refusal that produced it stays in `detail`.
 */
function upgradeRefusal(reason: HandoffRefusal): string {
	return reason === "handoff_unsupported" ? "upgrade_unsupported" : reason;
}

async function recordEnvScope(target: HostTarget, spec: ResolvedHostLaunchSpec): Promise<void> {
	const paths = createHostDaemonPaths({ socket: target.socket, agentDir: target.agentDir });
	await writeDaemonEnvKeys(paths, daemonEnvKeys(process.env, spec.env));
}

function assertNever(value: never): never {
	throw new Error(`unreachable host request: ${JSON.stringify(value)}`);
}
