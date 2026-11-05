import { RAISER_NOTICE_CAPABILITY } from "./custom-capability.ts";
import { serializeJsonLine } from "./jsonl.ts";
import type { RpcRemoteOrigin } from "./remote-origin.ts";
import type { SessionEventFanout } from "./session-event-fanout.ts";

/** Where a connection speaks from: delegated (senpi#5632) or declared `remoteOrigin` means not this machine's user. */
export interface ConnectionLocality {
	isRemote(connection: string): boolean;
	originOf(connection: string): RpcRemoteOrigin | undefined;
}

/**
 * Value-free notices of a raiser-only dialog (D11 S3-5): every attached connection other than the presenter that opted
 * into `raiser_notice_v1` learns that a secret or grant select is pending and when it settles. A notice never carries
 * a value, draft, answer id or receipt; like the prompt it bypasses replay, snapshots and observer lanes.
 */
type NoticeRecord = { readonly type: string; readonly [field: string]: unknown };

export class RaiserNotices {
	readonly #pending = new Map<string, Map<string, readonly string[]>>();
	private readonly fanout: SessionEventFanout;
	private readonly flush: () => void;
	constructor(fanout: SessionEventFanout, flush: () => void) {
		this.fanout = fanout;
		this.flush = flush;
	}

	raised(sessionId: string, uiRequestId: string, presenter: string | undefined, notice: NoticeRecord): void {
		const session = this.#pending.get(sessionId) ?? new Map<string, readonly string[]>();
		if (session.has(uiRequestId)) return;
		const recipients = this.fanout
			.attachedConnections(sessionId)
			.filter((id) => id !== presenter && this.fanout.connectionHas(id, RAISER_NOTICE_CAPABILITY));
		if (recipients.length === 0) return;
		session.set(uiRequestId, recipients);
		this.#pending.set(sessionId, session);
		this.#send(recipients, { ...notice, sessionId, uiRequestId });
	}

	settled(sessionId: string, uiRequestId: string, record: NoticeRecord): void {
		const session = this.#pending.get(sessionId);
		const recipients = session?.get(uiRequestId);
		if (session === undefined || recipients === undefined) return;
		session.delete(uiRequestId);
		if (session.size === 0) this.#pending.delete(sessionId);
		this.#send(recipients, { ...record, sessionId, uiRequestId });
	}

	dropSession(sessionId: string): void {
		this.#pending.delete(sessionId);
	}

	#send(recipients: readonly string[], record: object): void {
		const line = serializeJsonLine(record);
		for (const id of recipients) this.fanout.get(id)?.actor.enqueue(line);
		this.flush();
	}
}
