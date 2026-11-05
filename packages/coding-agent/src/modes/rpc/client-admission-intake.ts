import { randomUUID } from "node:crypto";
import type { AgentSession, PromptDisposition } from "../../core/agent-session.ts";
import {
	type ClientMessageIdentity,
	clientMessageIdentity,
	type PreparedClientInput,
} from "../../core/client-message-identity.ts";
import {
	admissionSnapshot,
	type ClientAdmissionRecord,
	type ClientMessageAdmission,
	ClientMessageIdConflict,
	clientInputFingerprint,
	HOST_MINTED_ID_PREFIX,
	type RpcClientInput,
} from "./client-admission-record.ts";

export type AdmissionHooks = {
	/** The identity to stamp on the input: the client's, or the one the host minted for an id-less queued input. */
	readonly identity: ClientMessageIdentity;
	readonly queued: (input: PreparedClientInput) => void;
	readonly accepted: (disposition: PromptDisposition, turnId?: string) => ClientMessageAdmission | undefined;
};

type ClientAdmissionIntake = {
	readonly ready: Promise<void>;
	hasIdentities: boolean;
	readonly session: AgentSession;
	readonly records: Map<string, ClientAdmissionRecord>;
	readonly pending: Map<string, { readonly fingerprint: string; readonly result: Promise<ClientMessageAdmission> }>;
	readonly save: (record: ClientAdmissionRecord) => void;
};

export async function admitClientInput(
	this: ClientAdmissionIntake,
	command: RpcClientInput,
	invoke: (hooks: AdmissionHooks) => Promise<PromptDisposition>,
): Promise<ClientMessageAdmission | undefined> {
	// Restored input keeps its place ahead of anything delivered after the ledger opened,
	// including deliveries that reach a freshly rebound session before its bind awaited this.
	await this.ready;
	this.hasIdentities ||= command.clientMessageId !== undefined || command.clientTurnId !== undefined;
	// An id-less steer/follow_up is still made durable under a host-minted id, so a reopen restores it;
	// that id is never answered back as the client's own. An id-less prompt keeps today's path.
	const hostMinted = command.clientMessageId === undefined && command.type !== "prompt";
	if (command.clientMessageId === undefined && !hostMinted) {
		await invoke({ identity: {}, queued: () => {}, accepted: () => undefined });
		return undefined;
	}
	const clientMessageId =
		command.clientMessageId ??
		`${HOST_MINTED_ID_PREFIX}${this.session.sessionManager.getSessionId()}:${randomUUID()}`;
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
			...(hostMinted ? { hostMinted: true as const } : {}),
		};
		const disposition = await invoke({
			identity: { ...clientMessageIdentity(command), clientMessageId },
			queued: (prepared) => this.save({ ...base, state: "queued", disposition: "queued", prepared }),
			accepted: (accepted, turnId) => {
				const record = this.records.get(clientMessageId) ?? {
					...base,
					state: accepted === "handled" ? ("completed" as const) : ("running" as const),
					disposition: accepted,
					...(turnId === undefined ? {} : { turnId }),
				};
				if (!this.records.has(clientMessageId)) this.save(record);
				return admissionSnapshot(record);
			},
		});
		const record = this.records.get(clientMessageId);
		if (!record) throw new Error(`RPC input was ${disposition} without a durable admission`);
		const snapshot = admissionSnapshot(record);
		result.resolve(snapshot);
		return hostMinted ? undefined : snapshot;
	} catch (error) {
		result.reject(error);
		throw error;
	} finally {
		this.pending.delete(clientMessageId);
	}
}
