import type { AgentSession } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { ClientAdmissions } from "./client-admissions.ts";
import { effectCrashPoint } from "./effect-crash-point.ts";
import { contextBudgetOutcome, EFFECT_OUTCOMES, modelSwitchErrorOutcome } from "./effect-outcome-copy.ts";
import {
	type EffectActor,
	type EffectCommandKind,
	EffectIdConflict,
	type EffectOutcome,
	type EffectState,
	type EffectStatus,
	effectFingerprint,
	isTerminalEffectState,
	RPC_EFFECT_ENTRY,
	type RpcEffectRecord,
	rpcEffectRecordSchema,
} from "./effect-record.ts";
import { projectAdmission, projectEffect } from "./effect-status.ts";

const ledgers = new WeakMap<AgentSession, EffectLedger>();

export type EffectBegin = { readonly replay: EffectStatus } | { readonly record: RpcEffectRecord };

/**
 * One durable effect ledger per loaded session. Every non-input effect is written to the transcript as
 * `accepted` BEFORE it is applied, then moves forward by appending a newer entry (the newest entry per
 * id wins on read). Input effects are the existing admission receipts, read through the same status.
 */
export class EffectLedger {
	private readonly records = new Map<string, RpcEffectRecord>();
	private readonly session: AgentSession;
	private readonly admissions: ClientAdmissions;
	private readonly durableSessionId: string;
	private readonly unsubscribe: () => void;

	private constructor(session: AgentSession) {
		this.session = session;
		this.admissions = ClientAdmissions.forSession(session);
		this.durableSessionId = session.sessionManager.getSessionId();
		const switchedBy = new Set<string>();
		const thinkingBy = new Set<string>();
		for (const entry of session.sessionManager.getEntries()) {
			if (entry.type === "model_change" && entry.effectId !== undefined) switchedBy.add(entry.effectId);
			if (entry.type === "thinking_level_change" && entry.effectId !== undefined) thinkingBy.add(entry.effectId);
			if (entry.type !== "custom" || entry.customType !== RPC_EFFECT_ENTRY) continue;
			const parsed = rpcEffectRecordSchema.safeParse(entry.data);
			if (parsed.success && parsed.data.durableSessionId === this.durableSessionId)
				this.records.set(parsed.data.effectId, parsed.data);
		}
		this.sealOnReopen(switchedBy, thinkingBy);
		this.unsubscribe = session.subscribe((event) => {
			if (this.durableSessionId !== session.sessionManager.getSessionId()) return;
			if (event.type === "model_changed" && event.origin.effectId !== undefined) {
				const record = this.records.get(event.origin.effectId);
				if (record?.kind === "set_model" && !isTerminalEffectState(record.state))
					this.transition(record.effectId, "done", { disposition: "applied" });
			} else if (event.type === "model_change_cancelled" && event.origin.effectId !== undefined) {
				const record = this.records.get(event.origin.effectId);
				if (record?.kind === "set_model" && !isTerminalEffectState(record.state))
					this.transition(record.effectId, "failed", {
						outcome:
							event.reason === "context-budget"
								? contextBudgetOutcome(event.detail ?? "the target model cannot hold the repaired context")
								: event.reason === "error"
									? modelSwitchErrorOutcome(event.detail ?? "the model switch failed")
									: EFFECT_OUTCOMES.setModelSuperseded,
					});
			} else if (event.type === "agent_idle") {
				for (const record of [...this.records.values()]) {
					if (record.kind === "abort" && record.state === "applied") this.transition(record.effectId, "done");
				}
			}
		});
	}

	/** Settle existing held effects while the outgoing transcript can still be written. */
	static sealOnReplace(runtime: AgentSessionRuntime): () => void {
		return runtime.onBeforeSessionReplace(() => {
			const ledger = ledgers.get(runtime.session);
			if (!ledger || ledger.durableSessionId !== runtime.session.sessionManager.getSessionId()) return;
			for (const record of [...ledger.records.values()]) {
				if (record.kind === "set_model" && !isTerminalEffectState(record.state))
					ledger.transition(record.effectId, "failed", { outcome: EFFECT_OUTCOMES.setModelDroppedByReplace });
			}
		});
	}

	static forSession(session: AgentSession): EffectLedger {
		let ledger = ledgers.get(session);
		if (ledger && ledger.durableSessionId !== session.sessionManager.getSessionId()) {
			ledger.unsubscribe();
			ledger = undefined;
		}
		if (!ledger) {
			ledger = new EffectLedger(session);
			ledgers.set(session, ledger);
		}
		return ledger;
	}

	/**
	 * A reopened session has no live turn, no teardown in flight and no pending model switch, so every
	 * nonterminal effect it finds is stale by definition. Seal each one before the ledger is published,
	 * so a same-id retry answers a terminal state and nothing stays pending forever.
	 */
	private sealOnReopen(switchedBy: ReadonlySet<string>, thinkingBy: ReadonlySet<string>): void {
		for (const record of [...this.records.values()]) {
			if (isTerminalEffectState(record.state)) continue;
			switch (record.kind) {
				case "abort":
					this.transition(record.effectId, "done", {
						disposition: "no_active_turn",
						outcome: EFFECT_OUTCOMES.abortInterruptedByReopen,
					});
					break;
				case "set_model":
					if (switchedBy.has(record.effectId))
						this.transition(record.effectId, "done", { disposition: "applied" });
					else
						this.transition(record.effectId, "failed", { outcome: EFFECT_OUTCOMES.setModelInterruptedByReopen });
					break;
				case "unload":
					this.transition(record.effectId, "done");
					break;
				case "set_thinking_level":
					if (thinkingBy.has(record.effectId))
						this.transition(record.effectId, "done", { disposition: "applied" });
					else
						this.transition(record.effectId, "failed", {
							outcome: EFFECT_OUTCOMES.setThinkingInterruptedByReopen,
						});
					break;
				case "dequeue":
					this.transition(record.effectId, "failed", { outcome: EFFECT_OUTCOMES.dequeueInterruptedByReopen });
					break;
			}
		}
	}

	/**
	 * Record a new effect as `accepted` (durably, before the caller applies it), or answer a replay.
	 * Same id + same semantic payload replays the stored status and the caller performs nothing; same id
	 * + a different payload throws `EffectIdConflict`.
	 */
	async begin(command: EffectCommandKind, effectId: string, payload: object, by: EffectActor): Promise<EffectBegin> {
		await this.session.sessionManager.persistHeaderNow();
		const fingerprint = effectFingerprint(command, payload);
		const existing = this.records.get(effectId);
		if (existing) {
			if (existing.fingerprint !== fingerprint) throw new EffectIdConflict(effectId);
			return { replay: projectEffect(existing) };
		}
		const now = new Date().toISOString();
		const record: RpcEffectRecord = {
			effectId,
			kind: command,
			state: "accepted",
			by,
			acceptedAt: now,
			updatedAt: now,
			durableSessionId: this.durableSessionId,
			fingerprint,
		};
		this.append(record);
		return { record };
	}

	transition(
		effectId: string,
		state: EffectState,
		patch: { readonly disposition?: string; readonly outcome?: EffectOutcome } = {},
	): EffectStatus {
		const current = this.records.get(effectId);
		if (!current) throw new Error(`No effect ${effectId} in session ${this.durableSessionId}`);
		this.append({ ...current, ...patch, state, updatedAt: new Date().toISOString() });
		return this.statusOf(effectId);
	}

	/** The newest status of `effectId`: a non-input effect, or an input receipt under the same id. */
	status(effectId: string, sessionId?: string): EffectStatus | undefined {
		const record = this.records.get(effectId);
		if (record) return projectEffect(record, sessionId);
		const admission = this.admissions.record(effectId);
		return admission === undefined ? undefined : projectAdmission(admission, sessionId);
	}

	private statusOf(effectId: string): EffectStatus {
		const status = this.status(effectId);
		if (!status) throw new Error(`No effect ${effectId} in session ${this.durableSessionId}`);
		return status;
	}

	private append(record: RpcEffectRecord): void {
		effectCrashPoint("before", record.kind, record.state);
		this.session.sessionManager.appendCustomEntry(RPC_EFFECT_ENTRY, record);
		this.records.set(record.effectId, record);
		effectCrashPoint("after", record.kind, record.state);
	}
}
