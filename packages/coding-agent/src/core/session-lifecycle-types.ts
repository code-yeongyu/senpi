/** Shared engine/RPC contract. Field names follow the approved lifecycle design. */
export type SessionLifecycleState =
	| "running"
	| "waiting_children"
	| "waiting_background"
	| "waiting_human"
	| "paused"
	| "held"
	| "done"
	| "failed"
	| "cancelled";

export interface HumanWait {
	readonly kind: "question" | "approval" | "goal_blocked" | "goal_paused" | "stalled" | "interrupted_run";
	readonly originSessionId: string;
	readonly requestId: string;
	readonly revision: number;
	readonly childSessionId?: string;
	readonly childLabel?: string;
	readonly since: string;
}

export interface LifecycleWaitItem {
	readonly id: string;
	readonly label?: string;
	readonly startedAt?: string;
}

export interface LifecycleWaitSource {
	readonly source: string;
	readonly activeCount: number;
	readonly items?: readonly LifecycleWaitItem[];
	readonly omittedItems?: number;
}

export interface LifecycleWaits {
	readonly children: number;
	/** Named detail can be incomplete even without truncation: custody need not have a named report. */
	readonly childSources?: readonly LifecycleWaitSource[];
	readonly childReports?: readonly Pick<
		ChildLifecycleReport,
		"taskId" | "childSessionId" | "runEpoch" | "state" | "label" | "since"
	>[];
	readonly childReportsOmitted?: number;
	readonly background: readonly (LifecycleWaitSource & {
		readonly retryAtMs?: number;
	})[];
	readonly human: readonly HumanWait[];
}

export interface LifecycleHold {
	readonly kind: "session_hold" | "run_fence" | "inherited_hold" | "unattended";
	readonly since: string;
}

/** Why the last run stopped, for that run only (`runId`); cleared when the next lifecycle run starts. */
export interface LifecycleStop {
	readonly cause: "deadline" | "goal_guard" | "todo_guard" | "aborted" | "no_wake";
	readonly runId: string;
	readonly at: string;
	readonly epoch: number;
	readonly deadline?: "inactivity" | "max_runtime";
	/** The goal guard reason exactly as `goal-continuation-stopped` recorded it. */
	readonly guard?: string;
	readonly todo?: "cap";
	readonly abortSource?: "user" | "system" | "provider";
	/** Present only when the deadline-stop entry write failed; distinct from the snapshot-level `persisted`. */
	readonly persisted?: false;
}

export interface SpawnedBy {
	readonly parentSessionId: string;
	readonly rootSessionId: string;
	readonly taskId: string;
}

export interface SessionLifecycle {
	readonly state: SessionLifecycleState;
	readonly seq: number;
	readonly epoch: number;
	readonly epochOrigin: "human" | "automatic";
	readonly completionId?: string;
	readonly humanInputRevision: number;
	readonly selfSettleEligible: boolean;
	readonly settleDecision?: { readonly decisionId: string };
	readonly restoring: boolean;
	readonly persisted: boolean;
	readonly runPaused: boolean;
	readonly since: string;
	readonly role: "root" | "child";
	readonly rootSessionId: string;
	readonly parentSessionId?: string;
	readonly taskId?: string;
	readonly waitingOn?: LifecycleWaits;
	readonly holds?: readonly LifecycleHold[];
	readonly lastStop?: LifecycleStop;
	readonly completion?: {
		readonly kind: "goal" | "run" | "agent" | "reply";
		readonly at: string;
		readonly goalId?: string;
		readonly runId?: string;
	};
	readonly failure?: {
		readonly reason: "provider_error" | "tool_error" | "task_error" | "lost" | "interrupted";
		readonly message?: string;
		readonly retryAtMs?: number;
		readonly taskId?: string;
		readonly runEpoch?: number;
	};
}

export interface ChildLifecycleReport {
	readonly taskId: string;
	readonly childSessionId: string;
	readonly runEpoch: number;
	readonly generation: number;
	readonly state: SessionLifecycleState;
	readonly label?: string;
	/** The child's own state-entry time, not the parent's evaluation time. */
	readonly since?: string;
	readonly waitingOn?: LifecycleWaits;
	readonly terminal?: "completed" | "error" | "lost" | "interrupted" | "cancelled";
}

export interface SelfSettleResult {
	readonly recorded: boolean;
	readonly reason?: "not_eligible" | "held" | "no_epoch";
	readonly epoch: number;
	readonly humanInputRevision: number;
}

export interface LifecycleApi {
	readonly obligations: WorkObligations;
	reportChild(report: ChildLifecycleReport): void;
	markRunCompleted(run: { readonly runId: string }): void;
}

export type ObligationKind = "children" | "background";
export type DeliveryTicketId = string;
export interface WorkObligations {
	open(key: string, kind: ObligationKind, detail?: string): ObligationToken;
}
export interface ObligationToken {
	transfer(nextKey: string, kind?: ObligationKind): ObligationToken;
	ticket(): DeliveryTicketId;
	heldAsNotice(noticeId: string): void;
	close(reason: "consumed" | "cancelled" | "passive"): void;
}

export interface SessionLifecycleEvent {
	readonly type: "session_lifecycle";
	readonly sessionId: string;
	readonly lifecycle: SessionLifecycle;
}
