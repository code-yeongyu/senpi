import type { RecoveryCarrier } from "../../core/session-recovery-identity.ts";

/**
 * The producer half of RULING-36a/40: one lifetime ordinal per acceptance unit (on a worker, the S04a output-frame
 * ordinal itself, never reset) and each message's first canonical ordinal, bound by the producer until its outer end.
 * Every message ends with a legacy `message_end` (completion, error and abort alike), so that record releases the
 * binding even when no canonical terminal paired with it; an epoch's end releases them all.
 */
export class CompactProducerStamp {
	private next = 0;
	private readonly first = new Map<string, number>();

	stamp(
		carrier: RecoveryCarrier | undefined,
		canonical: { readonly type: string } | undefined,
		legacy?: object,
	): { readonly ordinal: number; readonly firstOrdinal?: number } {
		const ordinal = this.next++;
		if (!carrier) return { ordinal };
		const ends =
			canonical?.type === "message_end" || (legacy !== undefined && Reflect.get(legacy, "type") === "message_end");
		const firstOrdinal = canonical ? (this.first.get(carrier.messageId) ?? ordinal) : undefined;
		if (ends) this.first.delete(carrier.messageId);
		else if (firstOrdinal !== undefined) this.first.set(carrier.messageId, firstOrdinal);
		return firstOrdinal === undefined ? { ordinal } : { ordinal, firstOrdinal };
	}

	/** A replacement starts a new epoch, in which no message of the old one continues. */
	forget(): void {
		this.first.clear();
	}
}
