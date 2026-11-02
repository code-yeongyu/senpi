import type { TurnEndLivenessInput } from "./extensions/builtin/goal/turn-end-liveness.ts";
import { readHumanWait, type SyntheticAttention } from "./lifecycle-attention.ts";
import { readLifecycleState, readWaits } from "./lifecycle-children.ts";
import { readLastStop } from "./lifecycle-stop.ts";
import type { LifecycleHold, SessionLifecycle } from "./session-lifecycle-types.ts";
import { isRecord } from "./work-custody-record.ts";

export interface LifecycleRecord extends Omit<SessionLifecycle, "activity" | "activityRevision"> {
	readonly sessionId: string;
	readonly attentionSeq: number;
	readonly synthetic: readonly SyntheticAttention[];
	readonly epochSealed: boolean;
	readonly settleRequest?: { readonly epoch: number; readonly revision: number };
	readonly runId?: string;
	readonly runActive: boolean;
	readonly interrupted: boolean;
	readonly completedGoalId?: string;
	readonly completedRunId?: string;
	readonly lastTurnEnd?: DurableTurnEnd;
}

export type DurableTurnEnd = Pick<
	TurnEndLivenessInput,
	"endedBy" | "deadlineStop" | "budgetSpent" | "providerRetryAtMs"
>;

/** Restore the wire snapshot and its private high-water marks from owned JSONL. */
export function readLifecycleRecord(value: unknown): LifecycleRecord | undefined {
	if (!isRecord(value)) return undefined;
	const state = readLifecycleState(value.state);
	if (
		!state ||
		typeof value.sessionId !== "string" ||
		typeof value.seq !== "number" ||
		typeof value.epoch !== "number" ||
		(value.epochOrigin !== "human" && value.epochOrigin !== "automatic") ||
		typeof value.humanInputRevision !== "number" ||
		typeof value.selfSettleEligible !== "boolean" ||
		typeof value.runPaused !== "boolean" ||
		typeof value.since !== "string" ||
		(value.role !== "root" && value.role !== "child") ||
		typeof value.rootSessionId !== "string"
	)
		return undefined;
	const synthetic: SyntheticAttention[] = [];
	if (Array.isArray(value.synthetic)) {
		for (const occurrence of value.synthetic) {
			if (!isRecord(occurrence) || typeof occurrence.key !== "string") continue;
			const wait = readHumanWait(occurrence.wait);
			if (wait) synthetic.push({ key: occurrence.key, wait });
		}
	}
	const waitingOn = readWaits(value.waitingOn);
	const holds = readHolds(value.holds);
	const completion = readCompletion(value.completion);
	const failure = readFailure(value.failure);
	const lastTurnEnd = readTurnEnd(value.lastTurnEnd);
	const lastStop = readLastStop(value.lastStop, value.runId);
	return {
		sessionId: value.sessionId,
		state,
		seq: value.seq,
		epoch: value.epoch,
		epochOrigin: value.epochOrigin,
		humanInputRevision: value.humanInputRevision,
		selfSettleEligible: value.selfSettleEligible,
		runPaused: value.runPaused,
		since: value.since,
		role: value.role,
		rootSessionId: value.rootSessionId,
		restoring: true,
		persisted: value.persisted === true,
		attentionSeq: typeof value.attentionSeq === "number" ? value.attentionSeq : 0,
		synthetic,
		epochSealed: value.epochSealed === true,
		runActive: value.runActive === true,
		interrupted: value.interrupted === true,
		...(typeof value.completedGoalId === "string" ? { completedGoalId: value.completedGoalId } : {}),
		...(typeof value.completedRunId === "string" ? { completedRunId: value.completedRunId } : {}),
		...(typeof value.completionId === "string" ? { completionId: value.completionId } : {}),
		...(typeof value.parentSessionId === "string" ? { parentSessionId: value.parentSessionId } : {}),
		...(typeof value.taskId === "string" ? { taskId: value.taskId } : {}),
		...(typeof value.runId === "string" ? { runId: value.runId } : {}),
		...(waitingOn ? { waitingOn } : {}),
		...(holds ? { holds } : {}),
		...(completion ? { completion } : {}),
		...(failure ? { failure } : {}),
		...(lastTurnEnd ? { lastTurnEnd } : {}),
		...(lastStop ? { lastStop } : {}),
		...(isRecord(value.settleDecision) && typeof value.settleDecision.decisionId === "string"
			? { settleDecision: { decisionId: value.settleDecision.decisionId } }
			: {}),
		...(isRecord(value.settleRequest) &&
		typeof value.settleRequest.epoch === "number" &&
		typeof value.settleRequest.revision === "number"
			? { settleRequest: { epoch: value.settleRequest.epoch, revision: value.settleRequest.revision } }
			: {}),
	};
}

function readTurnEnd(value: unknown): DurableTurnEnd | undefined {
	if (!isRecord(value) || typeof value.deadlineStop !== "boolean" || typeof value.budgetSpent !== "boolean")
		return undefined;
	switch (value.endedBy) {
		case "clean":
		case "user-abort":
		case "system-abort":
		case "provider-abort":
		case "unknown-abort":
		case "provider-error":
		case "policy-rejection":
			return {
				endedBy: value.endedBy,
				deadlineStop: value.deadlineStop,
				budgetSpent: value.budgetSpent,
				providerRetryAtMs: typeof value.providerRetryAtMs === "number" ? value.providerRetryAtMs : undefined,
			};
		default:
			return undefined;
	}
}

function readHolds(value: unknown): readonly LifecycleHold[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.flatMap((hold) => {
		if (!isRecord(hold) || typeof hold.since !== "string") return [];
		switch (hold.kind) {
			case "session_hold":
			case "run_fence":
			case "inherited_hold":
			case "unattended":
				return [{ kind: hold.kind, since: hold.since }];
			default:
				return [];
		}
	});
}

function readCompletion(value: unknown): SessionLifecycle["completion"] {
	if (!isRecord(value) || typeof value.at !== "string") return undefined;
	switch (value.kind) {
		case "goal":
		case "run":
		case "agent":
		case "reply":
			return {
				kind: value.kind,
				at: value.at,
				...(typeof value.goalId === "string" ? { goalId: value.goalId } : {}),
				...(typeof value.runId === "string" ? { runId: value.runId } : {}),
			};
		default:
			return undefined;
	}
}

function readFailure(value: unknown): SessionLifecycle["failure"] {
	if (!isRecord(value)) return undefined;
	switch (value.reason) {
		case "provider_error":
		case "tool_error":
		case "task_error":
		case "lost":
		case "interrupted":
			return {
				reason: value.reason,
				...(typeof value.message === "string" ? { message: value.message } : {}),
				...(typeof value.retryAtMs === "number" ? { retryAtMs: value.retryAtMs } : {}),
				...(typeof value.taskId === "string" ? { taskId: value.taskId } : {}),
				...(typeof value.runEpoch === "number" ? { runEpoch: value.runEpoch } : {}),
			};
		default:
			return undefined;
	}
}
