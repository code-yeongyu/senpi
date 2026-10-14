import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession, PromptDisposition } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import {
	clientMessageIdentity,
	type PreparedClientInput,
	readClientMessageIdentity,
} from "../../core/client-message-identity.ts";
import {
	admissionSnapshot,
	CLIENT_ADMISSION_ENTRY,
	type ClientAdmissionRecord,
	type ClientMessageAdmission,
	ClientMessageIdConflict,
	clientAdmissionRecordSchema,
	clientInputFingerprint,
	type RpcClientInput,
} from "./client-admission-record.ts";
import { EFFECT_OUTCOMES, turnErrorOutcome } from "./effect-outcome-copy.ts";
import type { EffectActor, EffectOutcome } from "./effect-record.ts";

type AdmissionHooks = {
	readonly queued: (input: PreparedClientInput) => void;
	readonly accepted: (disposition: PromptDisposition) => ClientMessageAdmission | undefined;
};

const sessions = new WeakMap<AgentSession, ClientAdmissions>();

/** One ledger per runtime; the transcript, not an attachment or request id, owns its history. */
export class ClientAdmissions {
	private readonly records = new Map<string, ClientAdmissionRecord>();
	private readonly pending = new Map<
		string,
		{ readonly fingerprint: string; readonly result: Promise<ClientMessageAdmission> }
	>();
	private restoring = true;
	/** How the current turn ended, read at its final `agent_end` and written by the `agent_idle` seal. */
	private turnOutcome: EffectOutcome | undefined;
	/** The client whose `abort` reached the current turn, for `outcome.abortedBy`. */
	private turnAbortedBy: EffectActor | undefined;
	private readonly session: AgentSession;
	private readonly durableSessionId: string;
	private readonly unsubscribeAgent: () => void;
	private readonly unsubscribeSession: () => void;
	hasIdentities = false;
	readonly ready: Promise<void>;

	private constructor(session: AgentSession) {
		this.session = session;
		const durableSessionId = session.sessionManager.getSessionId();
		this.durableSessionId = durableSessionId;
		for (const entry of session.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== CLIENT_ADMISSION_ENTRY) continue;
			// A custom entry is opaque transcript data: one that does not parse as an admission
			// (an extension reusing the type, a hand-edited file) is not an admission and must not
			// keep the session from opening.
			const parsed = clientAdmissionRecordSchema.safeParse(entry.data);
			if (parsed.success && parsed.data.durableSessionId === durableSessionId) {
				this.records.set(parsed.data.clientMessageId, parsed.data);
			}
		}
		this.hasIdentities = this.records.size > 0;
		// A ledger is built once per loaded session, so no turn can be live for a `running` record it
		// reads: that turn belonged to a process or load that is gone. Seal it before queued input is
		// restored, or the receipt reads `running` forever.
		for (const record of [...this.records.values()]) {
			if (record.state === "running")
				this.save({ ...record, state: "completed", outcome: EFFECT_OUTCOMES.inputInterruptedByReopen });
		}
		// Agent listeners are awaited before the next provider call; a crash cannot turn a
		// consumed queue record back into a replayable queued admission.
		this.unsubscribeAgent = session.agent.subscribe((event) => {
			if (this.durableSessionId !== session.sessionManager.getSessionId()) return;
			if (event.type !== "message_start" || event.message.role !== "user") return;
			const identity = readClientMessageIdentity(event.message);
			const record = identity.clientMessageId ? this.records.get(identity.clientMessageId) : undefined;
			if (record?.state === "queued") this.save({ ...record, state: "running", prepared: undefined });
		});
		this.unsubscribeSession = session.subscribe((event) => {
			if (this.restoring || this.durableSessionId !== session.sessionManager.getSessionId()) return;
			if (event.type === "agent_end") {
				if (!event.willRetry) this.turnOutcome = this.endOutcome(event.messages);
			} else if (event.type === "agent_idle") {
				const outcome = this.turnOutcome ?? { kind: "completed" as const };
				this.turnOutcome = undefined;
				this.turnAbortedBy = undefined;
				for (const record of this.records.values()) {
					if (record.state === "running") this.save({ ...record, state: "completed", outcome });
				}
			} else if (event.type === "queue_update") {
				const queuedIds = new Set(event.ordered.map((input) => input.clientMessageId));
				const consumingId = readClientMessageIdentity(session.agent.state.streamingMessage).clientMessageId;
				for (const record of this.records.values()) {
					if (record.state === "queued" && !queuedIds.has(record.clientMessageId)) {
						this.save({
							...record,
							state: consumingId === record.clientMessageId ? "running" : "completed",
							prepared: undefined,
						});
					}
				}
			}
		});
		// Publish this ledger in the WeakMap before restoration emits queue events.
		this.ready = Promise.resolve().then(() => this.restore());
	}

	/**
	 * Whenever `runtime` replaces its session, give the outgoing session's still-queued inputs a
	 * `dropped_by_replace` receipt. Only a ledger that already exists is touched: building one now would
	 * restore (replay) persisted queued input into a session that is being torn down.
	 */
	static sealQueuedOnReplace(runtime: AgentSessionRuntime): () => void {
		return runtime.onBeforeSessionReplace(() => sessions.get(runtime.session)?.dropQueuedByReplace());
	}

	static forSession(session: AgentSession): ClientAdmissions {
		let admissions = sessions.get(session);
		if (admissions && admissions.durableSessionId !== session.sessionManager.getSessionId()) {
			admissions.unsubscribeAgent();
			admissions.unsubscribeSession();
			admissions = undefined;
		}
		if (!admissions) {
			admissions = new ClientAdmissions(session);
			sessions.set(session, admissions);
		}
		return admissions;
	}

	/** The newest record for `clientMessageId` in this session, for effect status queries. */
	record(clientMessageId: string): ClientAdmissionRecord | undefined {
		return this.records.get(clientMessageId);
	}

	/** Remember who aborted the running turn; the turn's receipts name them once it ends. */
	noteAbort(by: EffectActor): void {
		if (this.session.isStreaming) this.turnAbortedBy = by;
	}

	/**
	 * The session is being replaced (`new_session`, `switch_session`, `fork`) and its queue is about to be
	 * discarded with it: give every still-queued input an honest terminal receipt in its own transcript, so
	 * a reopen of that file neither restores it nor reports it as delivered.
	 */
	dropQueuedByReplace(): void {
		if (this.durableSessionId !== this.session.sessionManager.getSessionId()) return;
		for (const record of [...this.records.values()]) {
			if (record.state !== "queued") continue;
			this.save({
				...record,
				state: "completed",
				prepared: undefined,
				outcome: EFFECT_OUTCOMES.inputDroppedByReplace,
			});
		}
	}

	private endOutcome(messages: readonly AgentMessage[]): EffectOutcome {
		const abortSource = this.session.currentAbortSource;
		if (abortSource !== undefined) {
			return {
				kind: "aborted",
				reason: "aborted",
				detail: "the turn was aborted before it finished",
				abortSource,
				...(this.turnAbortedBy === undefined ? {} : { abortedBy: this.turnAbortedBy }),
			};
		}
		const last = messages.at(-1);
		if (last?.role === "assistant" && last.stopReason === "error") return turnErrorOutcome(last.errorMessage);
		return { kind: "completed" };
	}

	private async restore(): Promise<void> {
		try {
			const queued = [...this.records.values()]
				.filter((record) => record.state === "queued")
				.sort((left, right) => left.prepared.enqueueOrder - right.prepared.enqueueOrder);
			for (const record of queued) {
				await this.session.restoreQueuedInput(record.prepared);
			}
		} finally {
			this.restoring = false;
		}
	}

	private save(record: ClientAdmissionRecord): void {
		this.session.sessionManager.appendCustomEntry(CLIENT_ADMISSION_ENTRY, record);
		this.records.set(record.clientMessageId, record);
	}

	async admit(
		command: RpcClientInput,
		invoke: (hooks: AdmissionHooks) => Promise<PromptDisposition>,
	): Promise<ClientMessageAdmission | undefined> {
		// Restored input keeps its place ahead of anything delivered after the ledger opened,
		// including deliveries that reach a freshly rebound session before its bind awaited this.
		await this.ready;
		this.hasIdentities ||= command.clientMessageId !== undefined || command.clientTurnId !== undefined;
		if (command.clientMessageId === undefined) {
			await invoke({ queued: () => {}, accepted: () => undefined });
			return undefined;
		}
		const clientMessageId = command.clientMessageId;
		const fingerprint = clientInputFingerprint(command);
		const pending = this.pending.get(clientMessageId);
		const existing = this.records.get(clientMessageId);
		if ((pending ?? existing)?.fingerprint !== undefined && (pending ?? existing)?.fingerprint !== fingerprint) {
			throw new ClientMessageIdConflict(clientMessageId);
		}
		if (pending) return pending.result;
		if (existing) return admissionSnapshot(existing);

		const result = Promise.withResolvers<ClientMessageAdmission>();
		this.pending.set(clientMessageId, { fingerprint, result: result.promise });
		// Joiners may attach later; the caller below still receives the original rejection.
		void result.promise.catch(() => {});
		try {
			await this.session.sessionManager.persistHeaderNow();
			const base = {
				...clientMessageIdentity(command),
				clientMessageId,
				durableSessionId: this.session.sessionManager.getSessionId(),
				fingerprint,
			};
			const disposition = await invoke({
				queued: (prepared) => this.save({ ...base, state: "queued", disposition: "queued", prepared }),
				accepted: (accepted) => {
					const record = this.records.get(clientMessageId) ?? {
						...base,
						state: accepted === "handled" ? ("completed" as const) : ("running" as const),
						disposition: accepted,
					};
					if (!this.records.has(clientMessageId)) this.save(record);
					return admissionSnapshot(record);
				},
			});
			const record = this.records.get(clientMessageId);
			if (!record) throw new Error(`RPC input was ${disposition} without a durable admission`);
			const snapshot = admissionSnapshot(record);
			result.resolve(snapshot);
			return snapshot;
		} catch (error) {
			result.reject(error);
			throw error;
		} finally {
			this.pending.delete(clientMessageId);
		}
	}
}
