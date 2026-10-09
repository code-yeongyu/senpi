import type { AgentSession, PromptDisposition } from "../../core/agent-session.ts";
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
			if (event.type === "agent_idle") {
				for (const record of this.records.values()) {
					if (record.state === "running") this.save({ ...record, state: "completed" });
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
