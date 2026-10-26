import { LifecycleAttention } from "./lifecycle-attention.ts";
import { type DurableTurnEnd, type LifecycleRecord, readLifecycleRecord } from "./lifecycle-record.ts";
import { lifecycleTerminal } from "./session-lifecycle-reducer.ts";
import type {
	LifecycleHold,
	LifecycleWaits,
	SelfSettleResult,
	SessionLifecycle,
	SessionLifecycleEvent,
	SessionLifecycleState,
	SpawnedBy,
} from "./session-lifecycle-types.ts";
import type { SessionEntry } from "./session-manager.ts";

export interface LifecyclePersistence {
	readonly sessionId: string;
	readonly spawnedBy?: SpawnedBy;
	readonly entries: readonly SessionEntry[];
	append(record: LifecycleRecord): void;
	emit(event: SessionLifecycleEvent): void;
}

/** Owns epoch/revision/decision ordering, separate from fact collection. */
export class LifecycleLedger {
	private current: SessionLifecycle;
	private readonly persistence: LifecyclePersistence;
	readonly attention: LifecycleAttention;
	private sealed = false;
	private request: LifecycleRecord["settleRequest"];
	private goalCompleted: string | undefined;
	private runCompleted: string | undefined;
	private admissionWriteFailed = false;
	private unwritten = false;
	runId: string | undefined;
	runActive = false;
	interrupted = false;
	lastTurnEnd: DurableTurnEnd | undefined;

	constructor(persistence: LifecyclePersistence) {
		this.persistence = persistence;
		let restored: LifecycleRecord | undefined;
		for (const entry of persistence.entries) {
			if (entry.type !== "custom" || entry.customType !== "session-lifecycle") continue;
			const parsed = readLifecycleRecord(entry.data);
			if (parsed?.sessionId === persistence.sessionId && (!restored || parsed.seq > restored.seq)) restored = parsed;
		}
		const spawnedBy = persistence.spawnedBy;
		this.current = restored
			? wireSnapshot(restored)
			: {
					state: "done",
					seq: 0,
					epoch: 0,
					epochOrigin: "automatic",
					humanInputRevision: 0,
					selfSettleEligible: true,
					restoring: true,
					persisted: false,
					runPaused: false,
					since: new Date().toISOString(),
					role: spawnedBy ? "child" : "root",
					rootSessionId: spawnedBy?.rootSessionId ?? persistence.sessionId,
					...(spawnedBy ? { parentSessionId: spawnedBy.parentSessionId, taskId: spawnedBy.taskId } : {}),
				};
		this.attention = new LifecycleAttention(persistence.sessionId, restored);
		this.sealed = restored?.epochSealed ?? false;
		this.runId = restored?.runId;
		this.interrupted = restored?.interrupted === true || (restored?.runActive === true && !this.sealed);
		this.goalCompleted = restored?.completedGoalId;
		this.runCompleted = restored?.completedRunId;
		this.lastTurnEnd = restored?.lastTurnEnd;
		// An unsealed restored intent cannot establish whether an unsaved human
		// input overtook it. Invalidate it before releasing the restore barrier.
		if (restored?.settleRequest && !this.sealed) this.current = { ...this.current, selfSettleEligible: false };
	}

	get snapshot(): SessionLifecycle {
		return this.current;
	}

	custodyWriteFailed(): void {
		this.current = { ...this.current, persisted: false, selfSettleEligible: false };
	}

	releaseRestoreBarrier(): void {
		this.current = { ...this.current, restoring: false };
	}

	humanInput(at: string): void {
		this.request = undefined;
		const { settleDecision: _decision, ...current } = this.current;
		// The first revision is input preparation, not an epoch-zero completion.
		const preparingFirstTurn = current.epoch === 0 && lifecycleTerminal(current.state);
		const next: SessionLifecycle = {
			...current,
			state: preparingFirstTurn ? "running" : current.state,
			humanInputRevision: current.humanInputRevision + 1,
			since: preparingFirstTurn ? at : current.since,
		};
		// Input that opens a new epoch is recorded by that epoch's opening record (senpi#3980). Input into an
		// open epoch is written at once: it must supersede a standing settle request durably.
		if (!this.runActive && (this.sealed || current.epoch === 0)) {
			this.current = next;
			this.unwritten = true;
		} else if (!this.write(next, true)) this.admissionWriteFailed = true;
	}

	startRun(origin: "human" | "automatic"): void {
		this.lastTurnEnd = undefined;
		this.openEpoch(origin);
		// The previous run's stop never describes this one (senpi#3864).
		const { lastStop: _lastStop, ...current } = this.current;
		this.current = current;
		this.runId = crypto.randomUUID();
		this.runActive = true;
		this.admissionWriteFailed = false;
		// A new run is unsaved state even inside an open epoch: recompute() treats records that differ only in runActive
		// or runId as equal, so without this a later run in the same epoch would never be recorded (senpi#3980).
		this.unwritten = true;
	}

	private openEpoch(origin: "human" | "automatic"): void {
		if (!this.sealed && this.current.epoch > 0) return;
		this.sealed = false;
		this.request = undefined;
		this.goalCompleted = undefined;
		this.runCompleted = undefined;
		const {
			completionId: _id,
			completion: _completion,
			failure: _failure,
			settleDecision: _decision,
			...current
		} = this.current;
		this.current = {
			...current,
			epoch: current.epoch + 1,
			epochOrigin: origin,
			selfSettleEligible: !this.admissionWriteFailed,
		};
		this.unwritten = true;
	}

	markGoalCompleted(goalId: string): void {
		if (this.current.epoch === 0 || this.sealed || this.goalCompleted === goalId) return;
		this.goalCompleted = goalId;
		this.checkpoint();
	}

	markRunCompleted(runId: string): void {
		if (this.current.epoch === 0 || this.sealed || this.runCompleted === runId) return;
		this.runCompleted = runId;
		this.checkpoint();
	}

	requestSelfSettle(): SelfSettleResult {
		const base = { epoch: this.current.epoch, humanInputRevision: this.current.humanInputRevision };
		if ((this.current.holds?.length ?? 0) > 0) return { ...base, recorded: false, reason: "held" };
		if (this.current.epoch === 0 || this.sealed) return { ...base, recorded: false, reason: "no_epoch" };
		if (!this.current.selfSettleEligible || this.current.role !== "root")
			return { ...base, recorded: false, reason: "not_eligible" };
		this.request = { epoch: this.current.epoch, revision: this.current.humanInputRevision };
		if (this.write(this.current, false)) return { ...base, recorded: true };
		this.request = undefined;
		this.current = { ...this.current, selfSettleEligible: false };
		return { ...base, recorded: false, reason: "not_eligible" };
	}

	update(input: {
		readonly state: SessionLifecycleState;
		readonly waits: LifecycleWaits;
		readonly holds: readonly LifecycleHold[];
		readonly failure?: SessionLifecycle["failure"];
		readonly lastStop?: SessionLifecycle["lastStop"];
	}): void {
		if (input.holds.length > 0 || input.state === "failed") this.request = undefined;
		const terminal = input.state === "done" || input.state === "failed";
		const {
			completionId: _id,
			completion: _completion,
			failure: _failure,
			settleDecision: _decision,
			lastStop: _lastStop,
			...base
		} = this.current;
		const now = new Date().toISOString();
		const standingRequest =
			this.request?.epoch === base.epoch &&
			this.request.revision === base.humanInputRevision &&
			base.selfSettleEligible &&
			input.holds.length === 0;
		const completion =
			input.state === "done" && base.epoch > 0
				? this.goalCompleted
					? { kind: "goal" as const, at: now, goalId: this.goalCompleted }
					: this.runCompleted
						? { kind: "run" as const, at: now, runId: this.runCompleted }
						: { kind: standingRequest ? ("agent" as const) : ("reply" as const), at: now }
				: undefined;
		const next: SessionLifecycle = {
			...base,
			state: input.state,
			waitingOn: input.waits,
			holds: input.holds,
			runPaused: input.holds.some((hold) => hold.kind === "run_fence"),
			since: input.state === this.current.state ? this.current.since : now,
			...(terminal && base.epoch > 0 ? { completionId: `${this.persistence.sessionId}:${base.epoch}` } : {}),
			...(completion
				? {
						completion:
							this.current.state === "done" && this.sealed
								? (this.current.completion ?? completion)
								: completion,
					}
				: {}),
			...(input.state === "failed" && input.failure ? { failure: input.failure } : {}),
			...(input.lastStop ? { lastStop: input.lastStop } : {}),
			...(input.state === "done" && standingRequest
				? {
						settleDecision: this.current.settleDecision ?? { decisionId: crypto.randomUUID() },
					}
				: {}),
			...(input.state === "done" && this.sealed && this.current.settleDecision
				? { settleDecision: this.current.settleDecision }
				: {}),
		};
		if (terminal && base.epoch > 0) this.sealed = true;
		if (this.current.restoring) {
			// Input changes during session_start are collected, but cannot publish.
			return;
		}
		if (this.current.persisted && equivalent(this.current, next)) return;
		// A brand-new idle session has no completed work epoch to announce.
		if (terminal && base.epoch === 0) {
			this.current = next;
			return;
		}
		this.write(next, true);
	}

	checkpoint(): void {
		this.write(this.current, false);
	}

	/** Publishes a revision or epoch that no record carries yet, once. */
	publishUnwritten(): void {
		if (this.unwritten) this.write(this.current, true);
	}

	private write(snapshot: SessionLifecycle, emit: boolean): boolean {
		const next = { ...snapshot, seq: this.current.seq + 1, persisted: true };
		const record: LifecycleRecord = {
			...next,
			sessionId: this.persistence.sessionId,
			attentionSeq: this.attention.attentionSeq,
			synthetic: this.attention.synthetic,
			epochSealed: this.sealed,
			runActive: this.runActive,
			interrupted: this.interrupted,
			...(this.lastTurnEnd ? { lastTurnEnd: this.lastTurnEnd } : {}),
			...(this.goalCompleted ? { completedGoalId: this.goalCompleted } : {}),
			...(this.runCompleted ? { completedRunId: this.runCompleted } : {}),
			...(this.runId ? { runId: this.runId } : {}),
			...(this.request ? { settleRequest: this.request } : {}),
		};
		this.unwritten = false;
		try {
			this.persistence.append(record);
			this.current = next;
		} catch (error) {
			if (!(error instanceof Error)) throw error;
			this.current = { ...next, persisted: false, selfSettleEligible: false };
		}
		if (emit && !this.current.restoring)
			this.persistence.emit({
				type: "session_lifecycle",
				sessionId: this.persistence.sessionId,
				lifecycle: this.current,
			});
		return this.current.persisted;
	}
}

function equivalent(previous: SessionLifecycle, next: SessionLifecycle): boolean {
	return (
		previous.state === next.state &&
		previous.epoch === next.epoch &&
		previous.humanInputRevision === next.humanInputRevision &&
		previous.runPaused === next.runPaused &&
		previous.selfSettleEligible === next.selfSettleEligible &&
		JSON.stringify(previous.waitingOn) === JSON.stringify(next.waitingOn) &&
		JSON.stringify(previous.holds) === JSON.stringify(next.holds) &&
		JSON.stringify(previous.failure) === JSON.stringify(next.failure) &&
		JSON.stringify(previous.lastStop) === JSON.stringify(next.lastStop)
	);
}

function wireSnapshot(record: LifecycleRecord): SessionLifecycle {
	const {
		sessionId: _sessionId,
		interrupted: _interrupted,
		completedGoalId: _goal,
		completedRunId: _completedRun,
		lastTurnEnd: _lastTurnEnd,
		attentionSeq: _attentionSeq,
		synthetic: _synthetic,
		epochSealed: _sealed,
		settleRequest: _request,
		runId: _runId,
		runActive: _runActive,
		...snapshot
	} = record;
	return snapshot;
}
