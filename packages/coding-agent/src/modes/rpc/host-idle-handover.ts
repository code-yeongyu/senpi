/**
 * The conditional idle handover, as the RUNNING host performs it.
 *
 * `senpi host handoff --when idle` names the generation it means (`ifInstanceId`, `ifGeneration`),
 * the runtime it wants serving (`targetRuntimeBuildId`) and one `operationId`. The host owns the
 * operation from then on, because only it can see its own turns and only it outlives the CLI call:
 *
 *   1. it checks, synchronously and before anything else, that it IS the named generation, and
 *      refuses `stale_generation` otherwise;
 *   2. it stops admitting new input (`admits`): prompts, steering, follow-ups, user bash,
 *      compaction, edits and wake deliveries are answered with a `handover_pending` error, while
 *      every turn already running keeps running and keeps its control traffic;
 *   3. it waits for its next safe idle point - no open session busy, no request in flight. An idle
 *      session that is merely retained is not work. The wait has NO deadline: a long turn delays the
 *      handover, it is never aborted for it;
 *   4. it starts the successor through the ordinary generation handoff (successor proven on the
 *      public socket, then this generation drains and parks its idle sessions for the successor to
 *      reopen by path). A successor that does not come up leaves this generation serving and admits
 *      input again (`handover_blocked { reason }`).
 *
 * A repeated `operationId` with the same terms answers with the operation that already exists,
 * whatever its state, so a caller that lost a reply can ask again without starting a second one; the
 * same id with other terms is refused (`operation_conflict`). Another id for the same target joins
 * the pending operation and is answered with ITS id; another target is refused
 * (`handover_in_progress`) until the pending operation ends.
 */
import type { HostLifecyclePolicyInput } from "./host-lifecycle.ts";

/**
 * Set on a successor launched by an idle handover: the runtime it must report. A successor that
 * computes another id exits before it listens, so the socket never moves to the wrong runtime.
 */
export const EXPECTED_RUNTIME_BUILD_ID_ENV = "SENPI_RPC_HOST_EXPECTED_RUNTIME_BUILD_ID";

export type HandoverState = "handover_pending" | "handover_switching" | "handover_completed" | "handover_blocked";

export interface HandoverLaunch {
	readonly command: string;
	readonly args: readonly string[];
}

export interface IdleHandoverRequest {
	readonly operationId: string;
	readonly ifInstanceId: string;
	readonly ifGeneration: number;
	readonly targetRuntimeBuildId: string;
	/** How the CLI that asked re-enters its own runtime as a supervisor: the successor runs THAT runtime. */
	readonly launch: HandoverLaunch;
	readonly hostArgs: readonly string[];
	/** The complete, already allowlisted daemon environment of the CLI that asked. */
	readonly env: Readonly<Record<string, string>>;
	readonly policy?: HostLifecyclePolicyInput;
}

export interface HandoverSuccessor {
	readonly pid: number;
	readonly instanceId: string;
	readonly generation: number;
	readonly runtimeBuildId: string | null;
}

export interface HandoverView {
	readonly operationId: string;
	readonly state: HandoverState;
	readonly targetRuntimeBuildId: string;
	readonly reason?: string;
	readonly successor?: HandoverSuccessor;
}

export type HandoverAnswer =
	| { readonly kind: "operation"; readonly view: HandoverView }
	| { readonly kind: "refused"; readonly reason: string; readonly detail?: string };

export type HandoverOutcome =
	| { readonly ok: true; readonly successor: HandoverSuccessor }
	| { readonly ok: false; readonly reason: string };

export interface HostIdentityView {
	readonly instanceId: string;
	readonly generation: number;
	readonly runtimeBuildId: string | undefined;
}

export interface HostIdleHandoverOptions {
	readonly identity: () => HostIdentityView;
	readonly isIdle: () => boolean;
	readonly perform: (request: IdleHandoverRequest) => Promise<HandoverOutcome>;
	/** How often a pending operation re-checks for idle between request settlements. */
	readonly pollMs?: number;
	readonly log?: (line: string) => void;
}

/** Commands that would start, extend or queue model work. Everything else stays admitted. */
const NEW_WORK_COMMANDS: ReadonlySet<string> = new Set([
	"prompt",
	"steer",
	"follow_up",
	"send_custom_message",
	"continue_from_leaf",
	"append_user_message",
	"bash",
	"compact",
	"wake",
	"edit_assistant_message",
	"edit_user_message",
]);

const DEFAULT_POLL_MS = 200;

interface Operation {
	readonly request: IdleHandoverRequest;
	view: HandoverView;
}

export class HostIdleHandover {
	private readonly options: HostIdleHandoverOptions;
	private operation: Operation | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;

	constructor(options: HostIdleHandoverOptions) {
		this.options = options;
	}

	/** The operation this host holds, for `get_protocol_info` and therefore `host status`. */
	view(): HandoverView | undefined {
		return this.operation?.view;
	}

	/** False while a handover holds new work back; a blocked one admits again. */
	admits(commandType: string): boolean {
		const state = this.operation?.view.state;
		return state === undefined || state === "handover_blocked" || !NEW_WORK_COMMANDS.has(commandType);
	}

	async begin(request: IdleHandoverRequest): Promise<HandoverAnswer> {
		const current = this.operation;
		if (current !== undefined && current.view.operationId === request.operationId) {
			return sameTerms(current.request, request)
				? answer(current)
				: { kind: "refused", reason: "operation_conflict", detail: "this operation id names other terms" };
		}
		if (current !== undefined && current.view.state !== "handover_blocked") {
			return current.request.targetRuntimeBuildId === request.targetRuntimeBuildId
				? answer(current)
				: { kind: "refused", reason: "handover_in_progress", detail: current.view.operationId };
		}
		const self = this.options.identity();
		if (self.instanceId !== request.ifInstanceId || self.generation !== request.ifGeneration) {
			return {
				kind: "refused",
				reason: "stale_generation",
				detail: `this host is ${self.instanceId} generation ${self.generation}`,
			};
		}
		if (self.runtimeBuildId === request.targetRuntimeBuildId) {
			return { kind: "refused", reason: "already_current", detail: self.runtimeBuildId };
		}
		const operation: Operation = {
			request,
			view: {
				operationId: request.operationId,
				state: "handover_pending",
				targetRuntimeBuildId: request.targetRuntimeBuildId,
			},
		};
		this.operation = operation;
		this.options.log?.(`handover ${request.operationId} pending: no new work is admitted`);
		if (this.idleNow()) {
			await this.switchOver(operation);
			return answer(operation);
		}
		this.timer = setInterval(() => this.observe(), this.options.pollMs ?? DEFAULT_POLL_MS);
		this.timer.unref?.();
		return answer(operation);
	}

	/** Re-checks a pending operation; the host calls it whenever a request settles. */
	observe(): void {
		const operation = this.operation;
		if (operation?.view.state === "handover_pending" && this.idleNow()) void this.switchOver(operation);
	}

	dispose(): void {
		this.stopTimer();
	}

	private idleNow(): boolean {
		try {
			return this.options.isIdle();
		} catch (cause) {
			this.options.log?.(`handover idle check failed, waiting: ${String(cause)}`);
			return false;
		}
	}

	private async switchOver(operation: Operation): Promise<void> {
		if (operation.view.state !== "handover_pending") return;
		this.stopTimer();
		operation.view = { ...operation.view, state: "handover_switching" };
		const outcome = await this.options
			.perform(operation.request)
			.catch(
				(cause: unknown): HandoverOutcome => ({ ok: false, reason: `successor_unavailable: ${String(cause)}` }),
			);
		operation.view = outcome.ok
			? { ...operation.view, state: "handover_completed", successor: outcome.successor }
			: { ...operation.view, state: "handover_blocked", reason: outcome.reason };
		this.options.log?.(`handover ${operation.view.operationId} ${operation.view.state}`);
	}

	private stopTimer(): void {
		if (this.timer !== undefined) clearInterval(this.timer);
		this.timer = undefined;
	}
}

function sameTerms(a: IdleHandoverRequest, b: IdleHandoverRequest): boolean {
	return (
		a.targetRuntimeBuildId === b.targetRuntimeBuildId &&
		a.ifInstanceId === b.ifInstanceId &&
		a.ifGeneration === b.ifGeneration
	);
}

function answer(operation: Operation): HandoverAnswer {
	return { kind: "operation", view: operation.view };
}
