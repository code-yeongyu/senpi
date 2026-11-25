import { join, resolve } from "node:path";
import { getAgentDir } from "../config.ts";
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
	HOST_EXIT_FALLBACK,
	HOST_EXIT_OK,
	HOST_EXIT_REFUSED,
	HOST_EXIT_USAGE,
	type HostRequest,
	type HostTarget,
	runHostRequest,
} from "../modes/rpc/host-runner.ts";
import type { HostStopGeneration } from "../modes/rpc/host-stop-generation.ts";
import { presenterBootstrapStream } from "../modes/rpc/mcp-presenter-bootstrap.ts";
import { type EngineResult, engineError, engineOk } from "./result.ts";

/** Which endpoint a host operation reaches: paths only (security design 5.6); the transport reads what is under them. */
export interface HostEndpointSelector {
	readonly socket?: string;
	readonly key_root?: string;
}

/** The private enrollment channel a new host receives on descriptor 4, and its enforcement opt-in. */
export interface HostPresenterInput {
	readonly bootstrap_fd: 4;
	readonly enforcement?: true;
}

export interface HostEndpointInput {
	readonly endpoint?: HostEndpointSelector;
}

export interface HostEnsureInput extends HostEndpointInput {
	/** A launch spec FILE; its owner and mode make it trustworthy, its directory resolves extension paths. */
	readonly launch_spec?: string;
	readonly policy?: HostDecisionPolicy;
	readonly presenter?: HostPresenterInput;
}

export interface HostStatusInput extends HostEndpointInput {
	/** Every endpoint under the agent directory, read without pruning. */
	readonly all?: boolean;
	readonly include_workers?: boolean;
}

export interface HostStopInput extends HostEndpointInput {
	readonly drain?: boolean;
	/** With `drain`: the generation to drain, by instance id. */
	readonly instance?: string;
	/** With `drain`: how long to wait for that generation to exit. */
	readonly wait_ms?: number;
	readonly force?: boolean;
	/** A hard stop of exactly this generation; never with `drain`. */
	readonly expected_generation?: HostStopGeneration;
}

export interface HostHandoffInput extends HostEndpointInput {
	readonly launch_spec?: string;
	readonly presenter?: HostPresenterInput;
	/** Hand a host on a newer engine down to this one. */
	readonly allow_downgrade?: boolean;
	/** The conditional form: the running host hands over to this runtime at its next safe idle point. */
	readonly when?: {
		readonly idle: {
			readonly operation: string;
			readonly if_instance: string;
			readonly if_generation: number;
			readonly target_build: string;
		};
	};
}

export interface HostGcInput extends HostEndpointInput {
	readonly agent_dir?: string;
}

export interface HostShardPathInput extends HostEndpointInput {
	readonly kind: ShardKind;
	readonly owner: string;
	readonly root?: string;
}

export type HostOperation =
	| ({ readonly operation: "ensure" } & HostEnsureInput)
	| ({ readonly operation: "status" } & HostStatusInput)
	| ({ readonly operation: "stop" } & HostStopInput)
	| ({ readonly operation: "handoff" } & HostHandoffInput)
	| ({ readonly operation: "gc" } & HostGcInput)
	| ({ readonly operation: "shard_path" } & HostShardPathInput);

/**
 * The endpoint, its key root and the presenter channel, as the core takes them: the CLI passes them from
 * `--socket`, `--rpc-key-root`, `--mcp-presenter-fd` and `--mcp-presenter-enforcement`, the exported functions
 * from `endpoint` and `presenter` (`hostEndpointOptions`).
 */
export interface HostEndpointOptions {
	readonly socket?: string;
	readonly keyRoot?: string;
	readonly presenterBootstrapFd?: number;
	readonly mcpPresenterEnforcement?: boolean;
}

/** `done`: it happened. `fallback`: no host is better than the running one (the `fallback` policy). */
export interface HostAnswer {
	readonly outcome: "done" | "fallback";
	readonly payload: Readonly<Record<string, unknown>>;
}

/** `refused`: a host this client may not act on. `usage`: an unusable input or launch spec. */
export type HostCode = "refused" | "failed" | "usage";

export function hostEndpointOptions(input: {
	readonly endpoint?: HostEndpointSelector;
	readonly presenter?: HostPresenterInput;
}): HostEndpointOptions {
	return {
		...(input.endpoint?.socket === undefined ? {} : { socket: input.endpoint.socket }),
		...(input.endpoint?.key_root === undefined ? {} : { keyRoot: resolve(input.endpoint.key_root) }),
		...(input.presenter === undefined ? {} : { presenterBootstrapFd: input.presenter.bootstrap_fd }),
		...(input.presenter?.enforcement === true ? { mcpPresenterEnforcement: true } : {}),
	};
}

/** The endpoint this client would reach: the one it was given, the branded override, or the default. */
export function resolveHostSocket(explicit: string | undefined, agentDir: string): string {
	return explicit ?? envValue("RPC_SOCKET") ?? resolve(agentDir, "rpc", "rpc.sock");
}

function launchSpec(specPath: string | undefined): Promise<ResolvedHostLaunchSpec> | ResolvedHostLaunchSpec {
	return specPath === undefined ? DEFAULT_HOST_LAUNCH_SPEC : loadHostLaunchSpec(specPath);
}

function handoverTerms(input: HostHandoffInput): IdleHandoverTerms | undefined {
	if (input.when === undefined) return undefined;
	const { idle } = input.when;
	return {
		operationId: idle.operation,
		ifInstanceId: idle.if_instance,
		ifGeneration: idle.if_generation,
		targetRuntimeBuildId: idle.target_build,
		...(input.allow_downgrade === true && { allowDowngrade: true }),
	};
}

function invalidInput(operation: HostOperation): string | undefined {
	if (operation.operation === "stop") {
		if ((operation.instance !== undefined || operation.wait_ms !== undefined) && operation.drain !== true)
			return "instance and wait_ms apply only with drain";
		if (operation.expected_generation !== undefined && operation.drain === true)
			return "expected_generation is for a hard stop, not drain";
		if (operation.wait_ms !== undefined && (!Number.isSafeInteger(operation.wait_ms) || operation.wait_ms <= 0))
			return "wait_ms must be a positive whole number of milliseconds";
	}
	if (operation.operation === "handoff" && operation.when !== undefined) {
		const { idle } = operation.when;
		if (!idle.operation || !idle.if_instance || !idle.target_build)
			return "when.idle needs operation, if_instance, if_generation and target_build";
		if (!Number.isSafeInteger(idle.if_generation) || idle.if_generation < 0)
			return "when.idle.if_generation must be a non-negative integer";
	}
	return undefined;
}

async function hostRequest(operation: HostOperation, socket: string | undefined): Promise<HostRequest> {
	const agentDir = getAgentDir();
	const target: HostTarget = { socket: resolveHostSocket(socket, agentDir), agentDir };
	switch (operation.operation) {
		case "ensure":
			return {
				action: "ensure",
				target,
				spec: await launchSpec(operation.launch_spec),
				policy: operation.policy ?? "upgrade",
			};
		case "status":
			return {
				action: "status",
				target,
				includeWorkers: operation.include_workers === true,
				all: operation.all === true,
			};
		case "stop":
			return {
				action: "stop",
				target,
				drain: operation.drain === true,
				force: operation.force === true,
				...(operation.expected_generation !== undefined && { expectedGeneration: operation.expected_generation }),
				...(operation.instance !== undefined && { instanceId: operation.instance }),
				...(operation.wait_ms !== undefined && { waitMs: operation.wait_ms }),
			};
		case "handoff": {
			const handover = handoverTerms(operation);
			return {
				action: "handoff",
				target,
				spec: await launchSpec(operation.launch_spec),
				...(handover !== undefined && { handover }),
				...(operation.allow_downgrade === true && { allowDowngrade: true }),
			};
		}
		case "shard_path":
			return {
				action: "shard_path",
				kind: operation.kind,
				owner: operation.owner,
				root: resolve(operation.root ?? join(agentDir, "rpc", "shards")),
			};
		case "gc":
			return { action: "gc", agentDir: resolve(operation.agent_dir ?? agentDir) };
		default: {
			const exhaustive: never = operation;
			return exhaustive;
		}
	}
}

function answer(exitCode: number, payload: Readonly<Record<string, unknown>>): EngineResult<HostAnswer, HostCode> {
	const reason = typeof payload.reason === "string" ? payload.reason : "host request failed";
	switch (exitCode) {
		case HOST_EXIT_OK:
			return engineOk({ outcome: "done", payload });
		case HOST_EXIT_FALLBACK:
			return engineOk({ outcome: "fallback", payload });
		case HOST_EXIT_REFUSED:
			return engineError("refused", reason, { details: { payload } });
		case HOST_EXIT_USAGE:
			return engineError("usage", reason, { details: { payload } });
		default:
			return engineError("failed", reason, { details: { payload } });
	}
}

/**
 * One host lifecycle operation, with every input the CLI has: the core both the `host` command and the
 * exported host functions run. Answers the JSON payload the command prints, as data or a refusal.
 */
export async function runHostOperation(
	operation: HostOperation,
	endpoint: HostEndpointOptions = {},
): Promise<EngineResult<HostAnswer, HostCode>> {
	const invalid =
		endpoint.presenterBootstrapFd !== undefined && endpoint.presenterBootstrapFd !== 4
			? "presenter.bootstrap_fd must be 4"
			: invalidInput(operation);
	if (invalid !== undefined)
		return answer(HOST_EXIT_USAGE, { action: "error", reason: "invalid_input", detail: invalid });
	try {
		const request = await hostRequest(operation, endpoint.socket);
		const presenterBootstrap =
			endpoint.presenterBootstrapFd === undefined
				? undefined
				: presenterBootstrapStream(endpoint.presenterBootstrapFd);
		const outcome = await runHostRequest(request, {
			keyRoot: endpoint.keyRoot,
			presenterBootstrap,
			mcpPresenterEnforcement: endpoint.mcpPresenterEnforcement,
		}).finally(() => presenterBootstrap?.destroy());
		return answer(outcome.exitCode, outcome.payload);
	} catch (error: unknown) {
		if (error instanceof HostLaunchSpecError) {
			return answer(HOST_EXIT_USAGE, { action: "error", reason: error.reason, detail: error.detail });
		}
		return answer(1, {
			action: "error",
			reason: "host_error",
			detail: error instanceof Error ? error.message : String(error),
		});
	}
}
