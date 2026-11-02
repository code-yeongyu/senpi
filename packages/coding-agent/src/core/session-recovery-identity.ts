import { randomUUID } from "node:crypto";

/**
 * The recovery identity of one session record. It is never a property on the record a session produces, so every
 * legacy record, and every record with the compact-updates flag off, keeps its bytes (R3.C1.2). One exception
 * (RULING-120, senpi#5331): with the flag on, the RPC host stamps the copy it sends a `compact_events` peer of a live
 * `message_end` (`messageId`, `terminalSequence`), `entry_appended` (`owningMessageId`) and `transcript_write_failed`
 * (`messageId`) with the ids the settled store recorded for that message, so that peer can join the live record to its
 * settled `message-<terminalSequence>` and `join-<n>` rows across a reconnect or recovery cut. The ids are opaque,
 * stable for the message's lifetime and never reused in the session; nothing else carries them.
 */
export interface RecoveryCarrier {
	readonly messageId: string;
	/** Host-issued nonce, internal to the producer/lane handshake; never serialized with a public record. */
	readonly epoch: string;
	readonly durableEntryId?: string;
}

const carriers = new WeakMap<object, RecoveryCarrier>();
const producers = new WeakMap<object, SessionRecoveryIdentity>();

/** Internal bootstrap, kept off AgentSession's public SDK surface. */
export function setSessionRecoveryEpoch(session: object, epoch: string): void {
	producers.get(session)?.reset(epoch);
}

export function recoveryCarrier(record: object): RecoveryCarrier | undefined {
	return carriers.get(record);
}

/** Every copy of a record on its way to the host lane keeps the original's carrier. */
export function carryRecovery<T extends object>(from: object, to: T): T {
	const carrier = carriers.get(from);
	if (carrier !== undefined && from !== to) carriers.set(to, carrier);
	return to;
}

type MessageEvent = { readonly type: string; readonly message?: { readonly role?: unknown } };

/**
 * Mints each message's opaque id at its start, in emission order. An assistant stream copies its message per
 * event, so it owns one open slot from start to end; other roles are keyed by their message object. A terminal
 * with no start mints at that terminal; an update with no start has no owner and gets no id.
 */
export class SessionRecoveryIdentity {
	private openAssistant: string | undefined;
	private byMessage = new WeakMap<object, string>();
	private epoch: string;

	constructor(epoch: string = randomUUID(), owner?: object) {
		this.epoch = epoch;
		if (owner) producers.set(owner, this);
	}

	reset(epoch: string): void {
		if (epoch === this.epoch) return;
		this.epoch = epoch;
		this.openAssistant = undefined;
		this.byMessage = new WeakMap();
	}

	/** A committed lifecycle delivery can predate its terminal record. */
	hint(event: object, durableEntryId: string | undefined): void {
		const carrier = carriers.get(event);
		if (carrier && durableEntryId) carriers.set(event, { ...carrier, durableEntryId });
	}

	/** A block control belongs to the assistant message open at its emission; it gets that message's identity. */
	own(control: object): void {
		if (this.openAssistant !== undefined) carriers.set(control, { messageId: this.openAssistant, epoch: this.epoch });
	}

	observe(event: MessageEvent): void {
		const message = event.message;
		if (message === undefined || carriers.has(event)) return;
		if (event.type !== "message_start" && event.type !== "message_update" && event.type !== "message_end") return;
		const assistant = message.role === "assistant";
		const known = assistant ? this.openAssistant : this.byMessage.get(message);
		const messageId =
			event.type === "message_start"
				? randomUUID()
				: (known ?? (event.type === "message_end" ? randomUUID() : undefined));
		if (messageId === undefined) return;
		if (assistant) this.openAssistant = event.type === "message_end" ? undefined : messageId;
		this.byMessage.set(message, messageId);
		const carrier = { messageId, epoch: this.epoch };
		carriers.set(event, carrier);
		carriers.set(message, carrier);
	}
}
