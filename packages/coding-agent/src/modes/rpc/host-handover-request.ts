/**
 * `senpi host handoff --when idle --operation <id> --if-instance <id> --if-generation <n> --target-build <id>`:
 * the client half of the conditional idle handover.
 *
 * The CLI may only ask for its OWN runtime: the successor is launched from this process's runtime
 * with the launch spec's extensions, so `--target-build` must be the `runtimeBuildId` this process
 * computes for that spec (`target_build_mismatch` otherwise). It checks what it can before asking -
 * the host serving the socket is the named generation, and it advertises the handover - and then
 * hands the operation to the HOST (`begin_handover`), which owns it from there (`host-idle-handover.ts`).
 *
 * Answers, exit 0: `handover_completed` (the successor now serves new sessions, or the target already serves
 * the socket - a repeated request after completion); `handover_pending` only from a host that answers before its
 * outcome. Exit 3: `migration_deferred` (the update may not overlap the running generation now, or the host is
 * one whose handover would refuse new work until it is idle: then nothing is sent and the update waits for its
 * cold start, code-yeongyu/oh-my-openagent#10091), `stale_generation`, `handover_blocked`,
 * `handover_in_progress`, `target_build_mismatch`, `handover_unsupported`, `no_host`.
 * Exit 1 `handover_reply_lost`: the host did not answer and the socket does not serve the target, so
 * the operation's fate is unknown until `host status` is read again.
 */
import { daemonEnvironment, daemonEnvOverrides } from "./host-daemon-env.ts";
import { createHostDaemonPaths } from "./host-daemon-paths.ts";
import { readHostRegistration } from "./host-daemon-registration.ts";
import type { HostProtocolInfo } from "./host-decision.ts";
import { STRICT_SESSION_TRANSFER_CAPABILITY } from "./custom-capability.ts";
import { foreignAgentDirRefusal } from "./host-handoff-agent-dir.ts";
import { HANDOVER_OUTCOME_BOUND_MS } from "./host-handover-operation.ts";
import { BEGIN_HANDOVER_COMMAND } from "./host-handover-wire.ts";
import { defaultHostLaunch } from "./host-launch.ts";
import type { ResolvedHostLaunchSpec } from "./host-launch-spec.ts";
import {
	clientRuntimeBuildId,
	HOST_EXIT_ERROR,
	HOST_EXIT_OK,
	type HostOutcome,
	identityPayload,
	refusal,
} from "./host-outcome.ts";
import { observeProtocolInfo, requestOnSocket } from "./host-probe.ts";
import { RUNTIME_IDENTITY_HANDOVER_CAPABILITY } from "./runtime-build-id.ts";

export interface IdleHandoverTerms {
	readonly operationId: string;
	readonly ifInstanceId: string;
	readonly ifGeneration: number;
	readonly targetRuntimeBuildId: string;
}

const PROBE_TIMEOUT_MS = 10_000;

/** The host answers with its admission outcome within the bound; the margin covers the reply's own transfer. */
const BEGIN_HANDOVER_TIMEOUT_MS = HANDOVER_OUTCOME_BOUND_MS + 15_000;

export async function idleHandoverOutcome(
	target: { readonly socket: string; readonly agentDir: string },
	spec: ResolvedHostLaunchSpec,
	terms: IdleHandoverTerms,
	mcpPresenterEnforcement?: boolean,
): Promise<HostOutcome> {
	const { socket } = target;
	if (process.platform === "win32") {
		return refusal("refuse", undefined, { reason: "upgrade_unsupported", socket, operationId: terms.operationId });
	}
	// Every read here observes: a probe connection the host still counts as a client would make an overlapping
	// update look like it leaves that client behind (code-yeongyu/oh-my-openagent#10091).
	const before = await observeProtocolInfo(socket, PROBE_TIMEOUT_MS);
	const refuse = (reason: string, extra: Record<string, unknown> = {}) =>
		refusal("refuse", before, { reason, socket, operationId: terms.operationId, ...extra });
	const foreign = before === undefined ? undefined : await foreignAgentDirRefusal(socket, target.agentDir, before);
	if (foreign) return refuse(foreign.reason, { detail: foreign.detail });
	const client = await clientRuntimeBuildId(spec);
	if (client !== terms.targetRuntimeBuildId) {
		return refuse("target_build_mismatch", {
			detail: `this CLI launches ${client ?? "a runtime it cannot read"}`,
			clientRuntimeBuildId: client,
		});
	}
	if (before === undefined) return refuse("no_host");
	if (before.runtimeBuildId === terms.targetRuntimeBuildId) {
		return answered(target, "handover_completed", before, terms, null);
	}
	if (before.instanceId !== terms.ifInstanceId || before.generation !== terms.ifGeneration) {
		return refuse("stale_generation", {
			detail: `the socket is served by ${before.instanceId ?? "an unnamed host"} generation ${before.generation ?? "?"}`,
		});
	}
	if (!before.capabilities.includes(RUNTIME_IDENTITY_HANDOVER_CAPABILITY)) return refuse("handover_unsupported");
	if (!before.capabilities.includes(STRICT_SESSION_TRANSFER_CAPABILITY)) {
		return refuse("migration_deferred", {
			detail:
				"legacy_predecessor_transfer: this host's handover would refuse new work until it is idle; the update applies at its next cold start",
		});
	}
	const reply = await requestOnSocket(
		socket,
		beginHandoverCommand(target, spec, terms, mcpPresenterEnforcement),
		BEGIN_HANDOVER_TIMEOUT_MS,
	);
	if (!isRecord(reply)) return reconcileLostReply(target, terms, before);
	if (typeof reply.refused === "string") {
		return refuse(reply.refused, typeof reply.detail === "string" ? { detail: reply.detail } : {});
	}
	if (reply.phase === "migration_deferred") {
		return refuse("migration_deferred", { detail: reply.reason ?? null, handover: reply });
	}
	if (reply.state === "handover_blocked") {
		return refuse("handover_blocked", { detail: reply.reason ?? null, handover: reply });
	}
	if (reply.state === "handover_completed") {
		return answered(target, "handover_completed", await observeProtocolInfo(socket, PROBE_TIMEOUT_MS), terms, reply);
	}
	return answered(target, "handover_pending", before, terms, reply);
}

function beginHandoverCommand(
	target: { readonly agentDir: string },
	spec: ResolvedHostLaunchSpec,
	terms: IdleHandoverTerms,
	mcpPresenterEnforcement?: boolean,
): Record<string, unknown> {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(
		daemonEnvironment(process.env, daemonEnvOverrides(process.env, spec.env)),
	)) {
		if (value !== undefined) env[name] = value;
	}
	const launch = defaultHostLaunch([]);
	return {
		type: BEGIN_HANDOVER_COMMAND,
		operation_id: terms.operationId,
		if_instance_id: terms.ifInstanceId,
		if_generation: terms.ifGeneration,
		target_runtime_build_id: terms.targetRuntimeBuildId,
		agent_dir: target.agentDir,
		launch: { command: launch.command, args: launch.args },
		host_args: spec.hostArgs,
		env,
		...(mcpPresenterEnforcement === true && { mcp_presenter_enforcement: true }),
		...(spec.policy !== undefined && { policy: spec.policy }),
	};
}

/** No answer is not a verdict: the socket says whether the target serves it now. */
async function reconcileLostReply(
	target: { readonly socket: string; readonly agentDir: string },
	terms: IdleHandoverTerms,
	before: HostProtocolInfo,
): Promise<HostOutcome> {
	const now = await observeProtocolInfo(target.socket, PROBE_TIMEOUT_MS);
	if (now?.runtimeBuildId === terms.targetRuntimeBuildId) {
		return answered(target, "handover_completed", now, terms, null);
	}
	return {
		exitCode: HOST_EXIT_ERROR,
		payload: {
			action: "error",
			reason: "handover_reply_lost",
			operationId: terms.operationId,
			...identityPayload(target.socket, await servingPid(target), now ?? before),
		},
	};
}

async function answered(
	target: { readonly socket: string; readonly agentDir: string },
	action: "handover_completed" | "handover_pending",
	host: HostProtocolInfo | undefined,
	terms: IdleHandoverTerms,
	handover: Readonly<Record<string, unknown>> | null,
): Promise<HostOutcome> {
	return {
		exitCode: HOST_EXIT_OK,
		payload: {
			action,
			...identityPayload(target.socket, await servingPid(target), host),
			operationId: typeof handover?.operation_id === "string" ? handover.operation_id : terms.operationId,
			clientRuntimeBuildId: terms.targetRuntimeBuildId,
			handover,
		},
	};
}

/** The supervisor pid the daemon directory names as serving the socket; 0 when none is recorded. */
async function servingPid(target: { readonly socket: string; readonly agentDir: string }): Promise<number> {
	const registered = await readHostRegistration(createHostDaemonPaths(target));
	return registered?.record.pid ?? 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
