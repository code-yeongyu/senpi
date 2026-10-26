/**
 * What stands between a parsed command and the session router on a multi-session host: the runtime-identity
 * handover's own request (`begin_handover`) and the runtime identity `get_protocol_info` reports. A handover
 * never gates a command (code-yeongyu/oh-my-openagent#10091): every command is routed exactly as on a host
 * without one, whatever the operation's phase.
 */

import { agentDirMismatch } from "./host-handoff-agent-dir.ts";
import { HandoverCoordinator, type HandoverCoordinatorOptions } from "./host-handover-coordinator.ts";
import {
	BEGIN_HANDOVER_COMMAND,
	beginHandoverResponse,
	parseBeginHandover,
	withHostIdentity,
} from "./host-handover-wire.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";

export interface HostCoreHooks {
	/** The runtime this host loaded at startup, reported by `get_protocol_info`. */
	readonly runtimeBuildId?: string;
	/** Present on a host that can hand over (a supervised POSIX socket host); the router supplies the rest. */
	readonly handover?: Omit<HandoverCoordinatorOptions, "clients" | "retained" | "seal">;
	/** This host's agent dir and public socket: a `begin_handover` naming another agent dir is refused (#3560). */
	readonly endpoint?: { readonly agentDir: string; readonly socket: string };
	/** Called with the in-process registry's session count after every open and close. */
	readonly onSessionCountChange?: (size: number) => void;
	/**
	 * Gate on the handover-parked reopen watch: returns false once this host is draining, so a
	 * predecessor never reopens into its own registry a session it just parked for its successor
	 * (senpi#3282). When omitted the watch always reopens.
	 */
	readonly shouldReopenParked?: () => boolean;
}

export class HostCoreGate {
	readonly handover: HandoverCoordinator | undefined;
	private readonly runtimeBuildId: string | undefined;
	private readonly endpoint: HostCoreHooks["endpoint"];
	private readonly answering = new Set<Promise<void>>();
	private readonly route: (command: RpcCommand) => Promise<RpcResponse | undefined>;

	constructor(
		route: (command: RpcCommand) => Promise<RpcResponse | undefined>,
		hooks: HostCoreHooks,
		router?: Pick<HandoverCoordinatorOptions, "clients" | "retained" | "seal">,
	) {
		this.route = route;
		this.runtimeBuildId = hooks.runtimeBuildId;
		this.endpoint = hooks.endpoint;
		this.handover =
			hooks.handover === undefined || router === undefined
				? undefined
				: new HandoverCoordinator({ ...hooks.handover, ...router });
	}

	/** Answers a `begin_handover` record through `deliver` and returns true, or returns false for anything else. */
	async intercept(parsed: unknown, deliver: (answer: object) => Promise<void>): Promise<boolean> {
		if (!isRecord(parsed) || parsed.type !== BEGIN_HANDOVER_COMMAND) return false;
		const answering = this.answerBegin(parsed).then(deliver);
		this.answering.add(answering);
		try {
			await answering;
		} finally {
			this.answering.delete(answering);
		}
		return true;
	}

	private async answerBegin(parsed: Readonly<Record<string, unknown>>): Promise<object> {
		if (this.handover === undefined) {
			return beginHandoverResponse(parsed.id, { kind: "refused", reason: "handover_unsupported" });
		}
		const request = parseBeginHandover(parsed);
		if (typeof request === "string") return beginHandoverResponse(parsed.id, request);
		// Settled before `begin` so its claim on the operation stays free of awaits.
		const detail =
			request.agentDir === undefined || this.endpoint === undefined
				? undefined
				: await agentDirMismatch(this.endpoint.socket, request.agentDir, this.endpoint.agentDir);
		return beginHandoverResponse(
			parsed.id,
			detail === undefined
				? await this.handover.begin(request)
				: { kind: "refused", reason: "foreign_agent_dir", detail },
		);
	}

	/**
	 * Settles once every `begin_handover` being answered has its answer. A host whose successor took the
	 * socket drains, and its shutdown waits here so the caller that asked is told the outcome instead of
	 * reading a closed connection.
	 */
	async answered(): Promise<void> {
		while (this.answering.size > 0) await Promise.allSettled([...this.answering]);
	}

	async dispatch(command: RpcCommand): Promise<object | undefined> {
		const response = await this.route(command);
		return response === undefined
			? undefined
			: withHostIdentity(response, this.runtimeBuildId, this.handover?.view());
	}
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
