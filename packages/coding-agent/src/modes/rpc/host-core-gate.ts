/**
 * What stands between a parsed command and the session router on a multi-session host: the
 * conditional idle handover's own request (`begin_handover`), the admission gate it closes on new
 * work, the per-session in-flight count the idle judgement reads, and the runtime identity
 * `get_protocol_info` reports. A host without hooks routes every command exactly as before.
 */

import { agentDirMismatch } from "./host-handoff-agent-dir.ts";
import {
	BEGIN_HANDOVER_COMMAND,
	beginHandoverResponse,
	handoverRefusal,
	isHostIdle,
	parseBeginHandover,
	withHostIdentity,
} from "./host-handover-wire.ts";
import { HostIdleHandover, type HostIdleHandoverOptions } from "./host-idle-handover.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import type { RpcSessionRegistry } from "./session-registry.ts";

export interface HostCoreHooks {
	/** The runtime this host loaded at startup, reported by `get_protocol_info`. */
	readonly runtimeBuildId?: string;
	/** Present on a host that can hand over at its next idle point (a POSIX socket host). */
	readonly handover?: Omit<HostIdleHandoverOptions, "isIdle">;
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
	readonly handover: HostIdleHandover | undefined;
	private readonly runtimeBuildId: string | undefined;
	private readonly endpoint: HostCoreHooks["endpoint"];
	private readonly inFlight = new Map<string | undefined, number>();
	private readonly answering = new Set<Promise<void>>();
	private readonly route: (command: RpcCommand) => Promise<RpcResponse | undefined>;

	constructor(
		registry: Pick<RpcSessionRegistry, "list" | "peek">,
		route: (command: RpcCommand) => Promise<RpcResponse | undefined>,
		hooks: HostCoreHooks,
	) {
		this.route = route;
		this.runtimeBuildId = hooks.runtimeBuildId;
		this.endpoint = hooks.endpoint;
		this.handover =
			hooks.handover === undefined
				? undefined
				: new HostIdleHandover({ ...hooks.handover, isIdle: () => isHostIdle(registry, this.inFlight) });
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
	 * Settles once every `begin_handover` being answered has its answer. A host idle at once drains
	 * the moment its successor takes the socket, and its shutdown waits here so the caller that asked
	 * is told the outcome instead of reading a closed connection.
	 */
	async answered(): Promise<void> {
		while (this.answering.size > 0) await Promise.allSettled([...this.answering]);
	}

	async dispatch(command: RpcCommand): Promise<object | undefined> {
		const pending = this.handover?.view();
		if (pending !== undefined && this.handover?.admits(command.type) === false) {
			return handoverRefusal(command, pending);
		}
		const key = "sessionId" in command ? command.sessionId : undefined;
		this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
		let response: RpcResponse | undefined;
		try {
			response = await this.route(command);
		} finally {
			const remaining = (this.inFlight.get(key) ?? 1) - 1;
			if (remaining > 0) this.inFlight.set(key, remaining);
			else this.inFlight.delete(key);
			this.handover?.observe();
		}
		return response === undefined
			? undefined
			: withHostIdentity(response, this.runtimeBuildId, this.handover?.view());
	}
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
