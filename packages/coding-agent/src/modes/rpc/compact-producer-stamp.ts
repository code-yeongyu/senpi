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
	private last: { ordinal: number; firstOrdinal?: number | undefined; messageId?: string | undefined } = {
		ordinal: -1,
	};

	stamp(
		carrier: RecoveryCarrier | undefined,
		canonical: { readonly type: string } | undefined,
		legacy?: object,
	): { readonly ordinal: number; readonly firstOrdinal?: number } {
		const ordinal = this.next++;
		this.last = { ordinal };
		if (!carrier) return { ordinal };
		const ends =
			canonical?.type === "message_end" || (legacy !== undefined && Reflect.get(legacy, "type") === "message_end");
		const firstOrdinal = canonical ? (this.first.get(carrier.messageId) ?? ordinal) : undefined;
		if (ends) this.first.delete(carrier.messageId);
		else if (firstOrdinal !== undefined) this.first.set(carrier.messageId, firstOrdinal);
		this.last = { ordinal, firstOrdinal, messageId: carrier.messageId };
		return firstOrdinal === undefined ? { ordinal } : { ordinal, firstOrdinal };
	}

	/**
	 * The unit stamped last becomes the final commit frame of a transfer whose `prefix` fragment frames take the ordinals
	 * before it (RULING-64): its ordinal moves past them, and so does a first-ordinal binding it started itself.
	 */
	defer(prefix: number): { readonly ordinal: number; readonly firstOrdinal?: number } {
		const { ordinal, firstOrdinal, messageId } = this.last;
		const moved = ordinal + prefix;
		this.next += prefix;
		if (firstOrdinal === undefined) return { ordinal: moved };
		if (firstOrdinal !== ordinal) return { ordinal: moved, firstOrdinal };
		if (messageId !== undefined && this.first.get(messageId) === ordinal) this.first.set(messageId, moved);
		return { ordinal: moved, firstOrdinal: moved };
	}

	/** A replacement starts a new epoch, in which no message of the old one continues. */
	forget(): void {
		this.first.clear();
	}
}
