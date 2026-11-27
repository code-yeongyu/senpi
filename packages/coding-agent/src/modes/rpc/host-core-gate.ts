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
import { type HostInstall, readHostInstall } from "./host-install.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import type { RpcSessionRegistry } from "./session-registry.ts";

export interface HostCoreHooks {
	/** The runtime this host loaded at startup, reported by `get_protocol_info`. */
	readonly runtimeBuildId?: string;
	/** The runtime root this host runs: `get_protocol_info` reports it and whether it is still on disk (senpi#7086). */
	readonly installPath?: string;
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
	/**
	 * Work outside the session registry (`machine_op` ops and terminals, senpi#6752): it keeps the host from being idle,
	 * and is held from the idle check that starts a handover's switch until that handover is blocked.
	 */
	readonly machineWork?: MachineWorkGate;
}

export interface MachineWorkGate {
	busy(): boolean;
	hold(): void;
	release(): void;
}

export class HostCoreGate {
	readonly handover: HostIdleHandover | undefined;
	private readonly runtimeBuildId: string | undefined;
	private readonly installPath: string | undefined;
	/** Read again before every `begin_handover` is judged, so the idle handover sees the install as it is now. */
	private installPresent: boolean | undefined;
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
		this.installPath = hooks.installPath;
		this.endpoint = hooks.endpoint;
		const handover = hooks.handover;
		this.handover =
			handover === undefined
				? undefined
				: new HostIdleHandover({
						...handover,
						identity: () => ({ ...handover.identity(), installPresent: this.installPresent }),
						isIdle: () => !(hooks.machineWork?.busy() ?? false) && isHostIdle(registry, this.inFlight),
						holdNewWork: () => hooks.machineWork?.hold(),
						releaseNewWork: () => hooks.machineWork?.release(),
					});
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
		this.installPresent = (await this.currentInstall())?.present;
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
		if (response === undefined) return undefined;
		const install = response.command === "get_protocol_info" ? await this.currentInstall() : undefined;
		return withHostIdentity(response, this.runtimeBuildId, this.handover?.view(), install);
	}

	private currentInstall(): Promise<HostInstall | undefined> {
		return this.installPath === undefined ? Promise.resolve(undefined) : readHostInstall(this.installPath);
	}
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
