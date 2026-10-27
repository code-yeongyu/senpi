import { randomUUID } from "node:crypto";

/** The recovery identity of one session record; never a property on the record, so no byte changes (R3.C1.2). */
export interface RecoveryCarrier {
	readonly messageId: string;
}

const carriers = new WeakMap<object, RecoveryCarrier>();

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
	private readonly byMessage = new WeakMap<object, string>();

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
		else this.byMessage.set(message, messageId);
		carriers.set(event, { messageId });
	}
}
