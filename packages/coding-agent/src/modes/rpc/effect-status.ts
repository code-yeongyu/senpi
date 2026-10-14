import type { ClientAdmissionRecord } from "./client-admission-record.ts";
import type { EffectState, EffectStatus, RpcEffectRecord } from "./effect-record.ts";

const ADMISSION_STATES: Readonly<Record<ClientAdmissionRecord["state"], EffectState>> = {
	queued: "accepted",
	running: "applied",
	completed: "done",
};

/** An input receipt as an effect: its `clientMessageId` IS its `effectId`. */
export function projectAdmission(record: ClientAdmissionRecord, sessionId?: string): EffectStatus {
	const outcome = record.state === "completed" ? record.outcome : undefined;
	return {
		effectId: record.clientMessageId,
		kind: "input",
		// A dropped input is stored as `completed` so older hosts never restore it; it never ran.
		state: outcome?.kind === "dropped_by_replace" ? "failed" : ADMISSION_STATES[record.state],
		disposition: record.disposition,
		...(outcome === undefined ? {} : { outcome }),
		...(sessionId === undefined ? {} : { sessionId }),
		durableSessionId: record.durableSessionId,
	};
}

export function projectEffect(record: RpcEffectRecord, sessionId?: string): EffectStatus {
	const { fingerprint: _fingerprint, ...status } = record;
	return sessionId === undefined ? status : { ...status, sessionId };
}
