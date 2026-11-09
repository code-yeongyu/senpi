/**
 * A headless (or client-owned) host rig with a takeover ledger over a memory DurableStore, for the quiet-takeover tests
 * (S37). `wrap` lets a test stand between the host and the ledger, e.g. to hold a takeover's commit open.
 */
import { createAdmissionLine } from "../../../agent/src/durable/store-admission.ts";
import { createMemoryStoreMedium, openMemoryStore } from "../../../agent/src/durable/store-memory.ts";
import { ATTACH_TAKEOVER_RECORD, type AttachLedger, createAttachLedger } from "../../src/modes/rpc/attach-ledger.ts";
import { attachmentWireResponse } from "../suite/rpc-attachment-wire-schema.ts";
import { type HostKind, type HostRig, startHostRig } from "./headless-host-support.ts";

export interface Opened {
	readonly sessionId: string;
	readonly durableSessionId: string;
	readonly file: string;
}

export async function takeoverRig(
	kind: HostKind = "headless",
	ledger = true,
	wrap: (ledger: AttachLedger) => AttachLedger = (inner) => inner,
) {
	const store = await openMemoryStore(createMemoryStoreMedium());
	await store.claim(0, 1);
	const sessionTakeover = wrap(createAttachLedger({ store, epoch: 1, admission: createAdmissionLine() }));
	const rig = await startHostRig(kind, {}, ledger ? { sessionTakeover } : {});
	let next = 0;
	const call = async (connection: string, command: Record<string, unknown>) => {
		const id = `call-${next++}`;
		await rig.send(connection, { ...command, id });
		const reply = await rig.response(id);
		if (command.type === "attach_session") attachmentWireResponse.parse(reply);
		return reply;
	};
	const open = async (connection: string): Promise<Opened> => {
		const file = await rig.newSessionFile();
		const reply = await call(connection, { type: "open_session", cwd: rig.root, sessionPath: file });
		const data = Object(reply.data);
		return { sessionId: String(data.sessionId), durableSessionId: String(Object(data.state).sessionId), file };
	};
	const takeOver = (connection: string, session: Opened, holder: string) =>
		call(connection, {
			type: "attach_session",
			sessionId: session.sessionId,
			durableSessionId: session.durableSessionId,
			takeover: true,
			holder,
		});
	const lifecycle = (connection: string) =>
		rig
			.recordsFor(connection)
			.filter((record) =>
				["session_released", "session_closed", "session_parked", "error"].includes(String(record.type)),
			);
	const takeovers = async () =>
		(await store.scanRecords())
			.filter(({ kind: recordKind }) => recordKind === ATTACH_TAKEOVER_RECORD)
			.map(({ data }) => `${String(Object(data).holder)}@${String(Object(data).generation)}`);
	const attachments = async (connection: string) =>
		Object.fromEntries((await rig.listSessions(connection)).map((row) => [row.sessionId, row.attachments]));
	return { rig, call, open, takeOver, lifecycle, takeovers, attachments };
}

export const released = (sessionId: string) => ({ type: "session_released", sessionId, reason: "taken_over" });

export async function disposing<T extends { rig: HostRig }>(setup: Promise<T>, body: (rig: T) => Promise<void>) {
	const ready = await setup;
	try {
		await body(ready);
	} finally {
		await ready.rig.dispose();
	}
}
