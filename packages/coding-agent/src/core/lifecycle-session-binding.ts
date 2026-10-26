import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "./agent-session.ts";
import { collectGoalLifecycleFacts, onGoalLifecycleChange } from "./extensions/builtin/goal/lifecycle-facts.ts";
import { goalStoreRef } from "./extensions/builtin/goal/store-ref.ts";
import { collectTurnEndLivenessInput } from "./extensions/builtin/goal/turn-end-liveness-report.ts";
import type { Goal } from "./extensions/builtin/goal/types.ts";
import type { ExtensionRunner } from "./extensions/runner.ts";
import { StaleExtensionContextError } from "./extensions/stale-context-error.ts";
import type { AgentEndEvent } from "./extensions/types.ts";
import { deliveryIdOf } from "./external-admission.ts";
import { consumeLifecycleDelivery, lifecycleDeliveryEntries, messageTicket } from "./lifecycle-delivery.ts";
import { readLifecycleGoal } from "./lifecycle-goal.ts";
import { lifecycleHistory } from "./lifecycle-history.ts";
import { bindLifecycleHumanInput } from "./lifecycle-human-input.ts";
import type { LifecycleRecord } from "./lifecycle-record.ts";
import { readLifecycleRuntimeFacts } from "./lifecycle-runtime-facts.ts";
import { goalGuardAfter, type RunStopFacts } from "./lifecycle-stop.ts";
import { wakeSourceItems } from "./lifecycle-wait-items.ts";
import { SessionLifecycleController } from "./session-lifecycle.ts";
import type { SessionLifecycleEvent } from "./session-lifecycle-types.ts";
import type { TurnDeadlineKind } from "./turn-deadline.ts";
import { isRecord } from "./work-custody-record.ts";

interface LifecycleBindingHost {
	append(type: string, data: unknown): string;
	emit(event: SessionLifecycleEvent): void;
	factsFailed(error: unknown): void;
}

/** Attaches durable lifecycle to the real session event/admission boundaries. */
export class LifecycleSessionBinding {
	readonly controller: SessionLifecycleController;
	readonly sessionId: string;
	private readonly session: AgentSession;
	private readonly host: LifecycleBindingHost;
	private readonly unsubscribeHuman: () => void;
	private readonly unsubscribeAdmission: () => void;
	private readonly unsubscribeGoal: () => void;
	private lastEnd: AgentEndEvent | undefined;
	/** The run each emitted agent_end belonged to, read when it was emitted, not when its queue reaches it. */
	private readonly boundEnds = new WeakMap<object, string | undefined>();
	private lastEndRunId: string | undefined;
	/** Captured once inside the bound end's own extension-processing window, never re-scanned by a later run. */
	private lastEndGuard: RunStopFacts["guard"];
	private refreshGeneration = 0;
	private restored = false;
	private nextRunOrigin: "human" | "automatic" | undefined;
	private restoring: Promise<void> | undefined;
	private retireFactEvents: (() => void) | undefined;
	/** After dispose() nothing the controller decides is written or emitted: the session file is no longer this session's. */
	private disposed = false;

	constructor(session: AgentSession, host: LifecycleBindingHost) {
		this.session = session;
		this.host = host;
		this.sessionId = session.sessionId;
		this.controller = new SessionLifecycleController({
			sessionId: session.sessionId,
			spawnedBy: session.sessionManager.getHeader()?.spawnedBy,
			entries: session.sessionManager
				.reduceHistory(lifecycleHistory)
				.filter(
					(entry) =>
						entry.type !== "custom" ||
						(entry.customType !== "work-custody" && entry.customType !== "child-lifecycle") ||
						(isRecord(entry.data) && entry.data.sessionId === session.sessionId),
				),
			append: (record: LifecycleRecord) => {
				this.write(() => host.append("session-lifecycle", record));
			},
			appendChild: (report) => {
				this.write(() => host.append("child-lifecycle", { ...report, sessionId: session.sessionId }));
			},
			appendCustody: (record) => {
				this.write(() => host.append("work-custody", { ...record, sessionId: session.sessionId }));
			},
			emit: (event) => {
				this.write(() => host.emit(event));
			},
			readRuntime: () => readLifecycleRuntimeFacts(session),
		});
		// A crashed receiver may have durable custody but no transcript entry yet. Recovery owns that
		// delivery already; register it before session_start can let the gateway enqueue a second carrier.
		const deliveries = session.sessionManager.reduceHistory(lifecycleDeliveryEntries);
		for (const record of this.controller.obligations.active) {
			// Discover consumed work before session_start can queue another automatic turn. The later
			// recovery pass still writes interruption/tool records, but must not be the first to close admission.
			if (record.ticketId && (record.state === "consumed" || deliveries.has(record.ticketId)))
				this.controller.ledger.interrupted = true;
			if (record.state !== "queued" || !record.payload || !record.ticketId) continue;
			const ticketId = record.ticketId;
			const message = { role: "custom" as const, ...record.payload.message, timestamp: 0 };
			const deliveryId = deliveryIdOf(message);
			if (deliveryId === undefined) continue;
			if (deliveries.has(ticketId)) session.externalAdmission.observePersisted(message);
			else
				session.externalAdmission.restoreQueued(
					deliveryId,
					() =>
						// Consumption writes the entry before message_end observes it in external admission.
						session.sessionManager.reduceHistory(lifecycleDeliveryEntries).has(ticketId) ||
						this.controller.obligations.active.some(
							(current) => current.ticketId === ticketId && current.state === "queued",
						),
				);
		}
		this.unsubscribeHuman = bindLifecycleHumanInput(session, (event) => this.controller.humanInput(event.at));
		this.unsubscribeAdmission = session.externalAdmission.onInputsSettled(() => this.controller.admissionSettled());
		this.unsubscribeGoal = onGoalLifecycleChange(session.sessionManager, (goal) => {
			void this.refreshFacts(goal).catch((error: unknown) => host.factsFailed(error));
			this.controller.goalChanged(goal);
		});
	}

	bindFactEvents(runner: ExtensionRunner): void {
		this.retireFactEvents?.();
		const refresh = () => {
			void this.refreshFacts().catch((error: unknown) => this.host.factsFailed(error));
		};
		const retire = [
			runner.onBusEvent("wake_source_state", (data) => {
				this.observeWakeSource(data);
				refresh();
			}),
			runner.onBusEvent("goal_continuation_timer_state", refresh),
			runner.onBusEvent("goal_store_changed", (data) => {
				if (isRecord(data) && data.threadId === this.sessionId) refresh();
			}),
		];
		this.retireFactEvents = () => {
			for (const unsubscribe of retire) unsubscribe();
		};
	}

	prepareRun(): void {
		this.nextRunOrigin = this.controller.nextRunOrigin;
		this.controller.noteRunAdmitted();
	}

	get isRestored(): boolean {
		return this.restored;
	}

	startRun(): void {
		this.lastEnd = undefined;
		this.lastEndGuard = undefined;
		const origin = this.nextRunOrigin;
		this.nextRunOrigin = undefined;
		this.controller.startRun(origin);
	}

	deadlineStopped(kind: TurnDeadlineKind, atMs: number): void {
		this.controller.deadlineStopped(kind, atMs);
	}

	deadlineStopWriteFailed(): void {
		this.controller.deadlineStopWriteFailed();
	}

	bindTurnEnd(end: object): void {
		this.boundEnds.set(end, this.controller.ledger.runId);
	}

	consume(message: AgentMessage): string | undefined {
		return this.write(() => consumeLifecycleDelivery(this.session, this.controller, message));
	}

	consumedEntry(message: AgentMessage): string | undefined {
		if (message.role !== "custom") return undefined;
		const ticketId = messageTicket(message);
		return ticketId ? this.session.sessionManager.reduceHistory(lifecycleDeliveryEntries).get(ticketId) : undefined;
	}

	/** `event` is the extension agent_end, never the session-level stamp; `end` is the core event bound at emission. */
	async turnEnded(event: AgentEndEvent, end: object, guardStartLeafId?: string | null): Promise<void> {
		this.lastEnd = event;
		this.lastEndRunId = this.boundEnds.get(end);
		this.lastEndGuard =
			guardStartLeafId === undefined
				? undefined
				: goalGuardAfter(this.session.sessionManager.getBranch(), guardStartLeafId);
		await this.refreshFacts();
	}

	async refreshFacts(changedGoal?: Goal | null): Promise<void> {
		const generation = ++this.refreshGeneration;
		const saved = this.lastEnd ? undefined : this.controller.lastTurnInput;
		const end = this.lastEnd ?? (saved ? { type: "agent_end" as const, messages: [] } : undefined);
		let collected: Awaited<ReturnType<typeof collectGoalLifecycleFacts>>;
		try {
			collected = await collectGoalLifecycleFacts(this.session.sessionManager, end, changedGoal);
		} catch (error) {
			// A collector registered by an extension generation that a reload or session replacement
			// retired reads through a stale ctx; the next session_start registers the live one.
			if (error instanceof StaleExtensionContextError) return;
			throw error;
		}
		const goal = collected
			? collected.goal
			: changedGoal === undefined
				? await readLifecycleGoal(goalStoreRef(this.session.sessionManager, this.session.cwd))
				: changedGoal;
		if (generation !== this.refreshGeneration) return;
		let input = collected?.input;
		// After session replacement or reload the runner is stale and its ctx throws on every read;
		// the replacing session owns lifecycle facts from then on.
		if (!input && end && this.session.extensionRunner.isActive) {
			const ctx = this.session.extensionRunner.createContext();
			input = collectTurnEndLivenessInput(ctx, end, {
				goal,
				todoOutcome: undefined,
				deadlineStop: false,
				continuationPending: false,
				monitor: {
					liveWakeSources: () => [...this.session.activeWakeSources],
					scheduledContinuation: () => undefined,
					hasStagedRecovery: () => false,
				},
			});
		}
		if (input && saved)
			input = {
				...input,
				endedBy: saved.endedBy,
				budgetSpent: input.budgetSpent || saved.budgetSpent,
				deadlineStop: input.deadlineStop || saved.deadlineStop,
				providerRetryAtMs: input.providerRetryAtMs ?? saved.providerRetryAtMs,
			};
		// Stop facts belong to the run that just ended in this process; a restored end carries its recorded stop.
		const stop = this.lastEnd
			? {
					runId: this.lastEndRunId,
					guard: this.lastEndGuard,
					todo: collected?.todoOutcome,
				}
			: undefined;
		this.controller.goalFacts(goal, input, stop);
	}

	async idle(): Promise<void> {
		await this.refreshFacts();
		this.controller.idle();
	}

	restore(): Promise<void> {
		if (this.restored) return Promise.resolve();
		this.restoring ??= this.recover();
		return this.restoring;
	}

	private async recover(): Promise<void> {
		await this.refreshFacts();
		// dispose() may land while the facts are read; a disposed binding restores nothing.
		if (this.disposed) return;
		const entries = this.session.sessionManager.reduceHistory(lifecycleHistory);
		const active = this.controller.obligations.active;
		for (const record of active) {
			if (!record.ticketId) continue;
			const ticketId = record.ticketId;
			const entryId = this.session.sessionManager.reduceHistory(lifecycleDeliveryEntries).get(ticketId);
			const transcript = entryId ? this.session.sessionManager.getEntry(entryId) : undefined;
			if (record.state !== "consumed" && !transcript) continue;
			if (transcript && record.state !== "consumed")
				this.controller.obligations.consumed(ticketId, {
					runId: record.runId ?? this.controller.ledger.runId ?? crypto.randomUUID(),
					transcriptEntryId: transcript.id,
				});
			this.controller.ledger.interrupted = true;
			if (
				!entries.some(
					(entry) =>
						entry.type === "custom" &&
						entry.customType === "interrupted-run" &&
						isRecord(entry.data) &&
						entry.data.ticketId === ticketId,
				)
			)
				this.hostAppendInterruption(ticketId, record.runId);
			this.recordInterruptedTools(transcript?.id ?? record.transcriptEntryId);
		}
		this.restored = true;
		this.controller.obligations.retireRestoredSources();
		this.controller.restoreComplete();
		for (const record of this.controller.obligations.active) {
			if (record.state !== "queued" || !record.payload || !record.ticketId) continue;
			if (this.disposed) return;
			await this.session.sendCustomMessage(record.payload.message, {
				triggerTurn: true,
				deliverAs: record.payload.deliverAs,
				ticket: record.ticketId,
			});
		}
	}

	private recordInterruptedTools(transcriptEntryId: string | undefined): void {
		if (!transcriptEntryId) return;
		const entries = this.session.sessionManager.getEntries();
		const start = entries.findIndex((entry) => entry.id === transcriptEntryId);
		if (start < 0) return;
		const pending = new Map<string, { readonly id: string; readonly name: string }>();
		for (const entry of entries.slice(start)) {
			if (entry.type !== "message") continue;
			if (entry.message.role === "assistant") {
				for (const part of entry.message.content) if (part.type === "toolCall") pending.set(part.id, part);
			} else if (entry.message.role === "toolResult") pending.delete(entry.message.toolCallId);
		}
		for (const call of pending.values())
			this.write(() =>
				this.session.sessionManager.appendMessage({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [
						{
							type: "text",
							text: "INTERRUPTED: the consuming run ended before this tool result was recorded. Side effects may be partial. The tool was not re-run.",
						},
					],
					details: { interrupted: { reason: "host_restart" } },
					isError: true,
					timestamp: Date.now(),
				}),
			);
		if (pending.size > 0)
			this.session.agent.state.messages = this.session.sessionManager.buildSessionContext().messages;
	}

	private hostAppendInterruption(ticketId: string, runId: string | undefined): void {
		this.write(() =>
			this.session.sessionManager.appendCustomEntry("interrupted-run", {
				ticketId,
				runId,
				status: "INTERRUPTED",
				reason: "host_restart",
				at: new Date().toISOString(),
			}),
		);
	}

	/**
	 * The single sink every write this binding makes goes through: the controller's records, custody and child
	 * reports, its events, the consumed delivery's transcript entry, and the restore-time interruption records.
	 * After dispose() nothing is written or emitted, because the session file is no longer this session's
	 * (senpi#4120 review, senpi#4149).
	 */
	private write<T>(record: () => T): T | undefined {
		if (this.disposed) return undefined;
		return record();
	}

	private observeWakeSource(data: unknown): void {
		if (!isRecord(data) || typeof data.source !== "string" || typeof data.activeCount !== "number") return;
		if (!Number.isFinite(data.activeCount)) return;
		this.controller.obligations.syncSource(
			data.source,
			data.kind === "children" ? "children" : "background",
			data.activeCount,
			wakeSourceItems(data),
		);
	}

	dispose(): void {
		this.disposed = true;
		this.refreshGeneration++;
		this.retireFactEvents?.();
		this.unsubscribeHuman();
		this.unsubscribeAdmission();
		this.unsubscribeGoal();
	}
}
