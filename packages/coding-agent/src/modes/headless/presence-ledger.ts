/**
 * The durable pause and resume records behind a headless engine's presence (C2, K7; senpi#5652).
 *
 * One pause per session and machine while that machine is offline: an append of `presence.pause` plus the open-pause
 * document, in one atomic commit. Its resume appends `presence.resume` and deletes the document in one commit, so a
 * resume is applied exactly once even across a restart: a second resume finds no open pause and writes nothing.
 */
import type { AdmissionLine, DurableStore, StoreValue } from "@earendil-works/pi-agent-core/conformance";

export const PRESENCE_PAUSE_RECORD = "presence.pause";
export const PRESENCE_RESUME_RECORD = "presence.resume";
const OPEN_PAUSE_PREFIX = "presence.open:";

/** Why a session waits: its owning machine (the placement) is offline, or a hand its tool calls run on is. */
export type PresenceRole = "owner" | "hand";

export interface PresencePause {
	readonly pauseId: string;
	readonly sessionId: string;
	readonly machine: string;
	readonly role: PresenceRole;
}

export interface PresenceLedger {
	/** Records that `sessionId` waits on `machine`; the caller holds at most one open pause per session and machine. */
	pause(sessionId: string, machine: string, role: PresenceRole): Promise<PresencePause>;
	/** Resumes the open pause of `sessionId` on `machine`; `undefined` when none is open (already resumed). */
	resume(sessionId: string, machine: string): Promise<PresencePause | undefined>;
	/** Every open pause, for recovery after a restart. */
	openPauses(): Promise<readonly PresencePause[]>;
}

const openKey = (sessionId: string, machine: string): string =>
	`${OPEN_PAUSE_PREFIX}${JSON.stringify([sessionId, machine])}`;

const isStoreArray = (value: StoreValue): value is readonly StoreValue[] => Array.isArray(value);

function decodePause(value: StoreValue): PresencePause {
	if (typeof value !== "object" || value === null || isStoreArray(value))
		throw new Error("presence: an open pause document is not an object");
	const { pauseId, sessionId, machine, role } = value;
	if (
		typeof pauseId !== "string" ||
		typeof sessionId !== "string" ||
		typeof machine !== "string" ||
		(role !== "owner" && role !== "hand")
	)
		throw new Error("presence: an open pause document is malformed");
	return { pauseId, sessionId, machine, role };
}

const encodePause = (pause: PresencePause): StoreValue => ({ ...pause });

/** All writers on one writable store epoch share its single admission line. */
export function createPresenceLedger(options: {
	readonly store: DurableStore;
	readonly epoch: number;
	readonly admission: AdmissionLine;
}): PresenceLedger {
	const { store, epoch, admission } = options;
	const read = async (key: string): Promise<PresencePause | undefined> => {
		const value = await store.getDocument(key);
		return value === undefined ? undefined : decodePause(value);
	};
	return {
		pause: (sessionId, machine, role) =>
			admission.admit(async () => {
				const key = openKey(sessionId, machine);
				const pause: PresencePause = { pauseId: store.mintId(), sessionId, machine, role };
				await store.commit(
					epoch,
					[
						{
							op: "append",
							id: `${PRESENCE_PAUSE_RECORD}:${pause.pauseId}`,
							kind: PRESENCE_PAUSE_RECORD,
							data: encodePause(pause),
						},
						{ op: "put", key, data: encodePause(pause) },
					],
					() => {},
				);
				return pause;
			}),
		resume: (sessionId, machine) =>
			admission.admit(async () => {
				const key = openKey(sessionId, machine);
				const open = await read(key);
				if (open === undefined) return undefined;
				await store.commit(
					epoch,
					[
						{
							op: "append",
							id: `${PRESENCE_RESUME_RECORD}:${open.pauseId}`,
							kind: PRESENCE_RESUME_RECORD,
							data: encodePause(open),
						},
						{ op: "delete", key },
					],
					() => {},
				);
				return open;
			}),
		openPauses: async () => (await store.scanDocuments(OPEN_PAUSE_PREFIX)).map(({ data }) => decodePause(data)),
	};
}
