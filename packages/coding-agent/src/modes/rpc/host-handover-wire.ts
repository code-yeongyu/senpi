/**
 * The host-side wire of the conditional idle handover: the `begin_handover` request a CLI sends,
 * the answers it gets, the refusal new work gets while a handover is pending, the identity fields
 * `get_protocol_info` gains, and the idle judgement over the session registry.
 *
 * `begin_handover` is answered with `success: true` whatever the verdict, so a client reads one
 * `data` shape: `{ state, operation_id, ... }` for an operation, `{ refused, detail }` for a refusal.
 */

import { writeDaemonEnvKeys } from "./host-daemon-env.ts";
import { createHostDaemonPaths } from "./host-daemon-paths.ts";
import { handoffHost } from "./host-handoff.ts";
import type { HandoverAnswer, HandoverOutcome, HandoverView, IdleHandoverRequest } from "./host-idle-handover.ts";
import { probeProtocolInfo } from "./host-probe.ts";
import type { RpcResponse } from "./rpc-types.ts";
import { selectDrainVerdicts } from "./session-drain.ts";
import type { RpcSessionRegistry } from "./session-registry.ts";

export const BEGIN_HANDOVER_COMMAND = "begin_handover";

const SUCCESSOR_PROBE_TIMEOUT_MS = 10_000;

export function parseBeginHandover(record: Readonly<Record<string, unknown>>): IdleHandoverRequest | string {
	const { operation_id, if_instance_id, if_generation, target_runtime_build_id, launch, host_args, env } = record;
	if (typeof operation_id !== "string" || operation_id === "") return "operation_id must be a non-empty string";
	if (typeof if_instance_id !== "string") return "if_instance_id must be a string";
	if (typeof if_generation !== "number" || !Number.isSafeInteger(if_generation))
		return "if_generation must be an integer";
	if (typeof target_runtime_build_id !== "string") return "target_runtime_build_id must be a string";
	if (!isRecord(launch) || typeof launch.command !== "string" || !isStringArray(launch.args)) {
		return "launch must be { command, args }";
	}
	if (!isStringArray(host_args)) return "host_args must be an array of strings";
	if (!isRecord(env) || !Object.values(env).every((value) => typeof value === "string")) {
		return "env must map names to strings";
	}
	const policy = isRecord(record.policy) ? record.policy : undefined;
	return {
		operationId: operation_id,
		ifInstanceId: if_instance_id,
		ifGeneration: if_generation,
		targetRuntimeBuildId: target_runtime_build_id,
		launch: { command: launch.command, args: launch.args },
		hostArgs: host_args,
		env: env as Readonly<Record<string, string>>,
		...(policy !== undefined && { policy }),
	};
}

export function beginHandoverResponse(id: unknown, answer: HandoverAnswer | string): Record<string, unknown> {
	const data =
		typeof answer === "string"
			? { refused: "invalid_request", detail: answer }
			: answer.kind === "refused"
				? { refused: answer.reason, ...(answer.detail !== undefined && { detail: answer.detail }) }
				: handoverWire(answer.view);
	return {
		...(typeof id === "string" && { id }),
		type: "response",
		command: BEGIN_HANDOVER_COMMAND,
		success: true,
		data,
	};
}

export function handoverWire(view: HandoverView): Record<string, unknown> {
	return {
		operation_id: view.operationId,
		state: view.state,
		target_runtime_build_id: view.targetRuntimeBuildId,
		...(view.reason !== undefined && { reason: view.reason }),
		...(view.successor !== undefined && { successor: view.successor }),
	};
}

/** What a command carrying new work gets while a handover holds it back. */
export function handoverRefusal(command: { readonly id?: string; readonly type: string }, view: HandoverView): object {
	return {
		...(command.id !== undefined && { id: command.id }),
		type: "response",
		command: command.type,
		success: false,
		error: `handover_pending: this host is handing over to runtime ${view.targetRuntimeBuildId} (operation ${view.operationId}); new work is admitted by its successor`,
	};
}

export function withHostIdentity(
	response: RpcResponse,
	runtimeBuildId: string | undefined,
	handover: HandoverView | undefined,
): object {
	if (response.command !== "get_protocol_info" || !response.success) return response;
	return {
		...response,
		data: {
			...response.data,
			...(runtimeBuildId !== undefined && { runtimeBuildId }),
			...(handover !== undefined && { handover: handoverWire(handover) }),
		},
	};
}

/**
 * The safe idle point: no session opening (an in-flight request without a session), and every
 * listed session open, without an in-flight request and not busy by its activity snapshot - the
 * same per-session judgement a drain parks by. A retained session with no work is idle.
 */
export function isHostIdle(
	registry: Pick<RpcSessionRegistry, "list" | "peek">,
	inFlight: ReadonlyMap<string | undefined, number>,
): boolean {
	if ((inFlight.get(undefined) ?? 0) > 0) return false;
	const sessions = registry.list();
	const verdicts = selectDrainVerdicts(
		registry,
		(sessionId) => (inFlight.get(sessionId) ?? 0) > 0,
		() => {},
	);
	return verdicts.park.length + verdicts.gone.length === sessions.length;
}

/**
 * Runs the handover the host decided on: the ordinary generation handoff, launched from the
 * runtime of the CLI that asked, with that CLI's daemon environment. The successor is told the
 * runtime it must report (`EXPECTED_RUNTIME_BUILD_ID_ENV`) and exits before it listens when it
 * computes another one, so a runtime changed since the request leaves this generation serving. The env is applied EXACTLY:
 * every name this host has and the CLI did not send is removed, so the successor does not inherit
 * the old runtime's view of the world.
 */
export async function performIdleHandover(context: {
	readonly request: IdleHandoverRequest;
	readonly socket: string;
	readonly agentDir: string;
}): Promise<HandoverOutcome> {
	const { request, socket, agentDir } = context;
	const env: Record<string, string | null> = {};
	for (const name of Object.keys(process.env)) env[name] = null;
	Object.assign(env, request.env);
	const result = await handoffHost({
		socket,
		agentDir,
		hostArgs: request.hostArgs,
		env,
		expectedRuntimeBuildId: request.targetRuntimeBuildId,
		...(request.policy !== undefined && { policy: request.policy }),
		launch: (argv) => ({ command: request.launch.command, args: [...request.launch.args, ...argv] }),
	});
	if (result.action === "refuse") {
		return { ok: false, reason: result.detail === undefined ? result.reason : `${result.reason}: ${result.detail}` };
	}
	// Bookkeeping after the socket moved: a failed write must not report a live successor as blocked.
	await writeDaemonEnvKeys(createHostDaemonPaths({ socket, agentDir }), Object.keys(request.env).sort()).catch(
		(cause: unknown) => {
			process.stderr.write(`senpi rpc handover: could not record the daemon environment: ${String(cause)}\n`);
		},
	);
	const successor = await probeProtocolInfo(socket, SUCCESSOR_PROBE_TIMEOUT_MS);
	return {
		ok: true,
		successor: {
			pid: result.pid,
			instanceId: result.instanceId,
			generation: result.generation,
			runtimeBuildId: successor?.runtimeBuildId ?? null,
		},
	};
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
