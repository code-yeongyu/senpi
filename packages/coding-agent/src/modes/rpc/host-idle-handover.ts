/**
 * The runtime-identity handover's request, answers and outcome types (`begin_handover`).
 *
 * `senpi host handoff --when idle` names the generation it means (`ifInstanceId`, `ifGeneration`), the runtime it
 * wants serving (`targetRuntimeBuildId`) and one `operationId`. The RUNNING host owns the operation from then on
 * (`host-handover-coordinator.ts`), and since code-yeongyu/oh-my-openagent#10091 it never closes its admission
 * for one: the answer is a bounded admission outcome, not an idle wait. The `--when idle` name stays for the
 * clients that send it; "idle" now describes when each SESSION moves, never a precondition for the whole host.
 *
 * A repeated `operationId` with the same terms answers with the operation that already exists, whatever its
 * state, so a caller that lost a reply can ask again without starting a second one; the same id with other terms is
 * refused (`operation_conflict`). Another id for the same target joins the operation in progress and is answered
 * with ITS id; another target is refused (`handover_in_progress`) until that operation reached its outcome.
 */
import type { HostLifecyclePolicyInput } from "./host-lifecycle.ts";
import type { HandoverPhase, LegacyHandoverState } from "./host-handover-operation.ts";

/**
 * Set on a successor launched by a handover: the runtime it must report. A successor that
 * computes another id exits before it listens, so the socket never moves to the wrong runtime.
 */
export const EXPECTED_RUNTIME_BUILD_ID_ENV = "SENPI_RPC_HOST_EXPECTED_RUNTIME_BUILD_ID";

/** Opts an endpoint in to OVERLAPPING updates while its clients migrate (`1`); absent or anything else is off. */
export const OVERLAP_HANDOVER_ENV = "SENPI_RPC_HOST_OVERLAP_HANDOVER";

export type HandoverState = LegacyHandoverState;

export interface HandoverLaunch {
	readonly command: string;
	readonly args: readonly string[];
}

export interface IdleHandoverRequest {
	/** Successor deployment policy only; never enrollment authority. */
	readonly mcpPresenterEnforcement?: boolean;
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
	/** The agent dir of the CLI that asked; absent from CLIs before #3560. Another dir than the host's is refused. */
	readonly agentDir?: string;
}

export interface HandoverSuccessor {
	readonly pid: number;
	readonly instanceId: string;
	readonly generation: number;
	readonly runtimeBuildId: string | null;
}

/** A session this generation still holds after its successor took the socket, and what holds it. */
export interface RetainedSession {
	readonly sessionId: string;
	readonly blockers: string;
}

export interface HandoverView {
	readonly operationId: string;
	readonly phase: HandoverPhase;
	readonly state: HandoverState;
	readonly targetRuntimeBuildId: string;
	readonly reason?: string;
	readonly successor?: HandoverSuccessor;
	readonly publishedAt?: number;
	readonly drainDeadlineAt?: number;
	readonly retained?: readonly RetainedSession[];
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
