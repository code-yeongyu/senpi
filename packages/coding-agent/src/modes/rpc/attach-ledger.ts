/**
 * The durable takeover record behind a headless engine's quiet takeover (R21; S37).
 *
 * One holder per durable session: the client that last took the session over. A takeover by a new holder appends
 * `attach.takeover` and replaces the holder document in one atomic commit, with the generation one higher. A takeover
 * by the current holder writes nothing, so a retried takeover is applied exactly once, across a restart too.
 */
import type { AdmissionLine, DurableStore, StoreValue } from "@earendil-works/pi-agent-core/conformance";

export const ATTACH_TAKEOVER_RECORD = "attach.takeover";
const HOLDER_PREFIX = "attach.holder:";

/** Who drives a session now: `generation` counts its holders, 1 for the first takeover. */
export interface AttachHolder {
	readonly takeoverId: string;
	readonly sessionId: string;
	readonly holder: string;
	readonly generation: number;
}

export interface AttachLedger {
	/** Makes `holder` the session's holder; returns the current record unchanged when it already is. */
	takeOver(sessionId: string, holder: string): Promise<AttachHolder>;
	/** The session's holder, `undefined` before its first takeover. */
	holderOf(sessionId: string): Promise<AttachHolder | undefined>;
}

const holderKey = (sessionId: string): string => `${HOLDER_PREFIX}${JSON.stringify(sessionId)}`;

const isStoreArray = (value: StoreValue): value is readonly StoreValue[] => Array.isArray(value);

function decodeHolder(value: StoreValue): AttachHolder {
	if (typeof value !== "object" || value === null || isStoreArray(value))
		throw new Error("attach: a holder document is not an object");
	const { takeoverId, sessionId, holder, generation } = value;
	if (
		typeof takeoverId !== "string" ||
		typeof sessionId !== "string" ||
		typeof holder !== "string" ||
		typeof generation !== "number" ||
		!Number.isSafeInteger(generation) ||
		generation < 1
	)
		throw new Error("attach: a holder document is malformed");
	return { takeoverId, sessionId, holder, generation };
}

const encodeHolder = (record: AttachHolder): StoreValue => ({ ...record });

/** All writers on one writable store epoch share its single admission line. */
export function createAttachLedger(options: {
	readonly store: DurableStore;
	readonly epoch: number;
	readonly admission: AdmissionLine;
}): AttachLedger {
	const { store, epoch, admission } = options;
	const holderOf = async (sessionId: string): Promise<AttachHolder | undefined> => {
		const value = await store.getDocument(holderKey(sessionId));
		return value === undefined ? undefined : decodeHolder(value);
	};
	return {
		holderOf,
		takeOver: (sessionId, holder) =>
			admission.admit(async () => {
				const current = await holderOf(sessionId);
				if (current?.holder === holder) return current;
				const next: AttachHolder = {
					takeoverId: store.mintId(),
					sessionId,
					holder,
					generation: (current?.generation ?? 0) + 1,
				};
				await store.commit(
					epoch,
					[
						{
							op: "append",
							id: `${ATTACH_TAKEOVER_RECORD}:${next.takeoverId}`,
							kind: ATTACH_TAKEOVER_RECORD,
							data: encodeHolder(next),
						},
						{ op: "put", key: holderKey(sessionId), data: encodeHolder(next) },
					],
					() => {},
				);
				return next;
			}),
	};
}
