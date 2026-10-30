import type { AgentEvent } from "@earendil-works/pi-agent-core";
import { effectiveWakes, type TurnEndLivenessInput } from "./extensions/builtin/goal/turn-end-liveness.ts";
import type { Goal } from "./extensions/builtin/goal/types.ts";
import { LifecycleChildren } from "./lifecycle-children.ts";
import { LifecycleLedger, type LifecyclePersistence } from "./lifecycle-ledger.ts";
import { projectWaitItems } from "./lifecycle-wait-items.ts";
import { type DeadlineStopCapture, type RunStopFacts, sameStop, stopDetail } from "./lifecycle-stop.ts";
import type { SessionActivitySnapshot } from "./session-activity.ts";
import { lifecycleState, lifecycleTerminal } from "./session-lifecycle-reducer.ts";
import type {
	ChildLifecycleReport,
	HumanWait,
	LifecycleHold,
	LifecycleWaits,
	SessionLifecycle,
} from "./session-lifecycle-types.ts";
import type { TurnDeadlineKind } from "./turn-deadline.ts";
import type { WorkCustodyRecord } from "./work-custody-record.ts";
import { SessionWorkObligations } from "./work-obligations.ts";

export interface LifecycleRuntimeFacts {
	readonly activity: SessionActivitySnapshot;
	readonly pendingMessages: number;
	readonly holds: readonly LifecycleHold[];
	readonly human: readonly HumanWait[];
	readonly inputAdmissionPending?: boolean;
}

export interface SessionLifecycleOptions extends LifecyclePersistence {
	readRuntime(): LifecycleRuntimeFacts;
	appendChild(report: ChildLifecycleReport): void;
	appendCustody(record: WorkCustodyRecord): void;
}

/** One event-driven reducer per session, shared by every client surface. */
export class SessionLifecycleController {
	readonly ledger: LifecycleLedger;
	readonly obligations: SessionWorkObligations;
	readonly children: LifecycleChildren;
	private readonly options: SessionLifecycleOptions;
	private idleBoundaryPassed = false;
	private pendingHuman = false;
	private admittingHuman = false;
	private runAdmitted = false;
	private goal: Goal | null = null;
	private liveness: TurnEndLivenessInput | undefined;
	private ownTask: ChildLifecycleReport | undefined;
	private evaluating = false;
	private deferred = false;
	private stopFacts: RunStopFacts | undefined;
	private deadlineStop: DeadlineStopCapture | undefined;
	private readonly outstandingTools = new Map<string, { toolName: string; toolCallId: string; since: string }>();
	private modelSince: string | undefined;
	/** A run that ended before this process keeps exactly the stop its record carries; none is derived for it. */
	private readonly restoredRunId: string | undefined;

	constructor(options: SessionLifecycleOptions) {
		this.options = options;
		this.ledger = new LifecycleLedger({
			...options,
			append: (record) => {
				this.obligations.flush();
				options.append(record);
			},
		});
		this.restoredRunId = this.ledger.runId;
		if (this.ledger.lastTurnEnd)
			this.liveness = {
				...this.ledger.lastTurnEnd,
				isChildSession: this.ledger.snapshot.role === "child",
				mode: "rpc",
				ledgerHold: undefined,
				willRetry: false,
				continuationQueued: undefined,
				goalStopped: false,
				openWork: { kind: "none" },
				expectations: [],
			};
		this.obligations = new SessionWorkObligations({
			entries: options.entries,
			append: (record) => options.appendCustody(record),
			changed: () => this.recompute(),
		});
		this.children = new LifecycleChildren({
			entries: options.entries,
			append: (report) => options.appendChild(report),
			changed: () => {
				this.ownTask = this.children.reports.find(
					(report) => report.childSessionId === options.sessionId && report.taskId === options.spawnedBy?.taskId,
				);
				this.recompute();
			},
		});
		for (const report of this.children.reports) {
			if (report.childSessionId === options.sessionId && report.taskId === options.spawnedBy?.taskId)
				this.ownTask = report;
		}
	}

	get snapshot(): SessionLifecycle {
		this.recompute();
		return this.ledger.snapshot;
	}

	get lastTurnInput(): TurnEndLivenessInput | undefined {
		return this.liveness;
	}

	get requiresHumanContinuation(): boolean {
		return this.ledger.interrupted && !this.pendingHuman;
	}

	get nextRunOrigin(): "human" | "automatic" {
		return this.pendingHuman ? "human" : "automatic";
	}

	restoreComplete(): void {
		this.ledger.releaseRestoreBarrier();
		this.idleBoundaryPassed = true;
		this.recompute();
		if (this.ledger.snapshot.seq > 0) this.ledger.checkpoint();
	}

	humanInput(at: string): void {
		this.admittingHuman = true;
		this.pendingHuman ||= !this.ledger.runActive;
		this.ledger.humanInput(at);
	}

	/** A turn was admitted and its run is about to start. */
	noteRunAdmitted(): void {
		this.runAdmitted = true;
	}

	admissionSettled(): void {
		this.admittingHuman = false;
		if (!this.ledger.runActive && !this.ledger.interrupted && this.options.readRuntime().pendingMessages === 0)
			this.pendingHuman = false;
		// An admitted run publishes its own opening record when it starts (senpi#3980).
		if (this.runAdmitted) return;
		this.recompute();
	}

	startRun(origin?: "human" | "automatic"): void {
		this.outstandingTools.clear();
		this.modelSince = undefined;
		this.admittingHuman = false;
		this.runAdmitted = false;
		this.idleBoundaryPassed = false;
		this.liveness = undefined;
		this.stopFacts = undefined;
		this.deadlineStop = undefined;
		const interruptedRun = this.ledger.interrupted ? this.ledger.runId : undefined;
		this.ledger.interrupted = false;
		this.ledger.startRun(origin ?? (this.pendingHuman ? "human" : "automatic"));
		this.pendingHuman = false;
		if (interruptedRun) this.obligations.settleRun(interruptedRun);
		this.recompute();
		this.ledger.publishUnwritten();
	}

	idle(): void {
		this.outstandingTools.clear();
		this.modelSince = undefined;
		this.runAdmitted = false;
		const seq = this.ledger.snapshot.seq;
		this.ledger.runActive = false;
		this.idleBoundaryPassed = true;
		const runId = this.ledger.runId;
		if (runId) this.obligations.settleRun(runId);
		this.recompute();
		if (seq > 0 && this.ledger.snapshot.seq === seq) this.ledger.checkpoint();
	}

	/** Synchronous core boundaries only; token/progress events never cause activity writes. */
	observeActivity(event: AgentEvent & { readonly parentToolCallId?: string }): void {
		if (!this.ledger.runActive) return;
		switch (event.type) {
			case "tool_execution_start":
				if (event.parentToolCallId !== undefined) return;
				this.outstandingTools.set(event.toolCallId, {
					toolName: event.toolName,
					toolCallId: event.toolCallId,
					since: new Date(Date.now()).toISOString(),
				});
				break;
			case "tool_execution_end":
				if (event.parentToolCallId !== undefined) return;
				this.outstandingTools.delete(event.toolCallId);
				break;
			case "message_start":
				if (event.message.role !== "assistant" || !event.streaming) return;
				this.modelSince = new Date(Date.now()).toISOString();
				break;
			case "message_end":
				if (event.message.role !== "assistant") return;
				this.modelSince = undefined;
				break;
			case "agent_end":
				this.outstandingTools.clear();
				this.modelSince = undefined;
				break;
			default:
				return;
		}
		this.recompute();
	}

	/** The turn deadline fired: captured before its durable write, for the run it stopped only. */
	deadlineStopped(kind: TurnDeadlineKind, atMs: number): void {
		const runId = this.ledger.runId;
		if (this.ledger.runActive && runId) this.deadlineStop = { runId, kind, at: new Date(atMs).toISOString() };
	}

	/** The deadline-stop entry was refused; the captured stop says so, and the snapshot's `persisted` is untouched. */
	deadlineStopWriteFailed(): void {
		if (this.deadlineStop) this.deadlineStop = { ...this.deadlineStop, persisted: false };
	}

	goalFacts(goal: Goal | null, input?: TurnEndLivenessInput, stop?: RunStopFacts): void {
		this.liveness = input;
		this.stopFacts = stop;
		if (input)
			this.ledger.lastTurnEnd = {
				endedBy: input.endedBy,
				budgetSpent: input.budgetSpent,
				deadlineStop: input.deadlineStop,
				providerRetryAtMs: input.providerRetryAtMs,
			};
		this.goalChanged(goal);
	}

	goalChanged(goal: Goal | null): void {
		if (goal?.status === "complete" && this.goal?.status !== "complete") this.ledger.markGoalCompleted(goal.id);
		this.goal = goal;
		this.recompute();
	}

	reportChild(report: ChildLifecycleReport): void {
		this.children.report(report);
	}

	requestSelfSettle() {
		if (this.admittingHuman || this.options.readRuntime().inputAdmissionPending)
			return {
				recorded: false,
				reason: "not_eligible" as const,
				epoch: this.ledger.snapshot.epoch,
				humanInputRevision: this.ledger.snapshot.humanInputRevision,
			};
		this.recompute();
		return this.ledger.requestSelfSettle();
	}

	markRunCompleted(runId: string): void {
		this.ledger.markRunCompleted(runId);
		this.recompute();
	}

	recompute(): void {
		if (!this.obligations.persisted) this.ledger.custodyWriteFailed();
		if (this.ledger.snapshot.restoring || this.admittingHuman) return;
		if (this.evaluating) {
			this.deferred = true;
			return;
		}
		this.evaluating = true;
		try {
			do {
				this.deferred = false;
				this.evaluate();
			} while (this.deferred);
		} finally {
			this.evaluating = false;
		}
	}

	private evaluate(): void {
		const runtime = this.options.readRuntime();
		const active = this.obligations.active;
		const childRecords = this.children.reports
			.filter((report) => report.childSessionId !== this.options.sessionId && report.terminal === undefined)
			.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
		const childReports = childRecords
			.slice(0, 32)
			.map(({ taskId, childSessionId, runEpoch, state, label, since }) => ({
				taskId,
				childSessionId,
				runEpoch,
				state,
				...(label === undefined ? {} : { label }),
				...(since === undefined ? {} : { since }),
			}));
		const childSources = active
			.filter((record) => record.kind === "children")
			.map((record) => ({
				source: record.source ?? record.key,
				activeCount: record.activeCount ?? 1,
				...projectWaitItems(record),
			}));
		const background: LifecycleWaits["background"][number][] = active
			.filter((record) => record.kind === "background")
			.map((record) => ({
				source: record.source ?? record.key,
				activeCount: record.activeCount ?? 1,
				...projectWaitItems(record),
			}));
		const children = Math.max(
			childRecords.length,
			active
				.filter((record) => record.kind === "children")
				.reduce((sum, record) => sum + (record.activeCount ?? 1), 0),
		);
		const input = this.liveness;
		let continuationQueued = input?.willRetry === true || input?.continuationQueued !== undefined;
		let questionToUser = false;
		for (const expectation of input ? effectiveWakes(input) : []) {
			switch (expectation.kind) {
				case "pending-messages":
					continuationQueued ||= runtime.pendingMessages > 0;
					break;
				// A person's queued input starts the next turn itself (#3865).
				case "user-input-queued":
					continuationQueued = true;
					break;
				case "armed-timer":
					if (expectation.timer === "userGrace") continuationQueued = true;
					else
						background.push({
							source: expectation.timer === "providerRetry" ? "provider-retry" : "goal-monitor",
							activeCount: 1,
							...(expectation.timer === "providerRetry" && input?.providerRetryAtMs !== undefined
								? { retryAtMs: input.providerRetryAtMs }
								: {}),
						});
					break;
				case "recovery-staged":
					background.push({ source: "staged-recovery", activeCount: 1 });
					break;
				case "wake-source":
					if (active.some((record) => record.source === expectation.source)) break;
					// A channel name is not a producer-declared kind.
					background.push({ source: expectation.source, activeCount: 1 });
					break;
				case "question-to-user":
					questionToUser = true;
					break;
				default:
					expectation satisfies never;
			}
		}
		const synthetic: { key: string; kind: HumanWait["kind"] }[] = [];
		const root = this.ledger.snapshot.role === "root";
		if (root) {
			if (questionToUser && runtime.human.length === 0)
				synthetic.push({ key: `question:${this.ledger.runId ?? this.ledger.snapshot.epoch}`, kind: "question" });
			if (this.goal?.status === "blocked") synthetic.push({ key: `goal:${this.goal.id}`, kind: "goal_blocked" });
			else if (this.goal && (this.goal.status === "paused" || this.goal.continuationStoppedAt !== undefined))
				synthetic.push({ key: `goal:${this.goal.id}`, kind: "goal_paused" });
			if (this.ledger.interrupted)
				synthetic.push({ key: `interrupted:${this.ledger.snapshot.epoch}`, kind: "interrupted_run" });
			const noWake =
				children === 0 && background.length === 0 && !continuationQueued && runtime.pendingMessages === 0;
			if (
				input &&
				noWake &&
				input.endedBy !== "provider-error" &&
				input.endedBy !== "policy-rejection" &&
				(input.deadlineStop ||
					input.budgetSpent ||
					input.endedBy === "unknown-abort" ||
					input.endedBy === "system-abort" ||
					input.endedBy === "provider-abort" ||
					((input.openWork.kind === "active-goal"
						? this.goal?.status === "active"
						: input.openWork.kind !== "none") &&
						!input.goalStopped))
			)
				synthetic.push({ key: `stall:${this.ledger.snapshot.epoch}`, kind: "stalled" });
			else if (
				noWake &&
				this.goal?.status === "active" &&
				!this.ledger.runActive &&
				!runtime.activity.isStreaming &&
				!runtime.activity.hasSessionWork &&
				!runtime.activity.isCompacting &&
				!runtime.activity.isBashRunning &&
				this.goal.continuationStoppedAt === undefined
			)
				synthetic.push({ key: `stall:${this.ledger.snapshot.epoch}`, kind: "stalled" });
		}
		const human = root ? [...runtime.human, ...this.ledger.attention.reconcile(synthetic)] : [];
		const running =
			this.ledger.runActive ||
			runtime.activity.isStreaming ||
			runtime.activity.isCompacting ||
			runtime.activity.isBashRunning ||
			runtime.activity.hasSessionWork ||
			runtime.pendingMessages > 0 ||
			continuationQueued;
		const failure: SessionLifecycle["failure"] =
			input &&
			(input.endedBy === "provider-error" || input.endedBy === "policy-rejection") &&
			!continuationQueued &&
			background.length === 0
				? {
						reason: "provider_error",
						...(input.providerRetryAtMs === undefined ? {} : { retryAtMs: input.providerRetryAtMs }),
					}
				: this.ownTask?.terminal === "error" ||
					  this.ownTask?.terminal === "lost" ||
					  this.ownTask?.terminal === "interrupted"
					? {
							reason: this.ownTask.terminal === "error" ? "task_error" : this.ownTask.terminal,
							taskId: this.ownTask.taskId,
							runEpoch: this.ownTask.runEpoch,
						}
					: undefined;
		const waits: LifecycleWaits = {
			children,
			background,
			human,
			...(childSources.length ? { childSources } : {}),
			...(childReports.length ? { childReports } : {}),
			...(childRecords.length > 32 ? { childReportsOmitted: childRecords.length - 32 } : {}),
		};
		const lastStop = this.lastStop(
			input,
			synthetic.some((wait) => wait.kind === "stalled"),
		);
		const state = lifecycleState({
			role: this.ledger.snapshot.role,
			terminal: this.ownTask?.terminal,
			holds: runtime.holds,
			waits,
			running,
			failure,
		});
		// A terminal task record owns a child's outcome, even if its local
		// producer registry has not drained after the runner stopped it.
		if (
			lifecycleTerminal(state) &&
			this.ownTask?.terminal === undefined &&
			(!this.idleBoundaryPassed || active.length > 0)
		)
			return;
		const oldest = this.outstandingTools.values().next().value;
		const activity: SessionLifecycle["activity"] =
			state !== "running"
				? undefined
				: oldest
					? { kind: "tool", ...oldest, outstanding: this.outstandingTools.size }
					: this.modelSince
						? { kind: "model", since: this.modelSince }
						: undefined;
		this.ledger.update({ state, waits, holds: runtime.holds, failure, lastStop, activity });
	}

	/**
	 * Derived only from the current run's own end, bound when its agent_end was emitted: an end processed after a
	 * later run started sets nothing, and so does a fact refresh that carries no bound turn end, even when the goal
	 * collector still returns the previous run's end. An unchanged stop keeps its first `at`.
	 */
	private lastStop(input: TurnEndLivenessInput | undefined, stalled: boolean): SessionLifecycle["lastStop"] {
		const existing = this.ledger.snapshot.lastStop;
		const runId = this.ledger.runId;
		if (!runId || runId === this.restoredRunId) return existing;
		if (this.stopFacts?.runId !== runId) return existing;
		const deadline = input && this.deadlineStop?.runId === runId ? this.deadlineStop : undefined;
		const detail = stopDetail(input, this.stopFacts, deadline, stalled);
		if (!detail) return existing;
		if (existing && sameStop(existing, detail)) return existing;
		const { at, ...cause } = detail;
		return { ...cause, runId, epoch: this.ledger.snapshot.epoch, at: at ?? new Date().toISOString() };
	}
}
