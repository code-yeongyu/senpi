import { type CompactTransition, CompactTransitionError } from "./compact-transition.ts";

type Start = Extract<CompactTransition, { type: "block_start" }>;

/** R1 uses the producer's lifetime ordinal and the S05 opaque nonce, never a receipt-time identity. */
export class CompactStartIdentity {
	private current: string | undefined;
	private highWater = -1;
	private readonly live = new Map<string, { epoch: string; firstOrdinal: number }>();
	/** Exactly the last 64 retirements, not an unbounded historical nonce catalog. */
	// After 64 newer epochs an evicted epoch is indistinguishable from a new one;
	// re-accepting it makes it current and retires the live current epoch (takeover).
	// This is acceptable only because S05 nonces are random and terminated-worker
	// channels are closed. S03b-2/3 replaces this with current-epoch-only acceptance
	// against the S05 registry, removing the retired set and this hole.
	private readonly retired = new Set<string>();

	validate({ epoch, ordinal, firstOrdinal, messageId }: Start): void {
		const binding = this.live.get(messageId);
		if (
			typeof epoch !== "string" ||
			!epoch.length ||
			!Number.isSafeInteger(ordinal) ||
			ordinal < 0 ||
			!Number.isSafeInteger(firstOrdinal) ||
			firstOrdinal < 0 ||
			firstOrdinal > ordinal ||
			(binding && (binding.epoch !== epoch || binding.firstOrdinal !== firstOrdinal))
		)
			throw new CompactTransitionError(
				"invalid_start_identity",
				"valid epoch, ordinal and stable first ordinal required",
			);
		if (
			this.retired.has(epoch) ||
			(epoch === this.current && (ordinal <= this.highWater || (!binding && firstOrdinal <= this.highWater)))
		)
			throw new CompactTransitionError(
				"duplicate_or_stale_start",
				"retired epoch or stale ordinal; bootstrap a new producer epoch before restarting its counter",
			);
		if (!binding && firstOrdinal !== ordinal)
			throw new CompactTransitionError("invalid_start_identity", "a new message must bind its own first start");
	}

	/** Called only after every semantic validation and the root publication succeeded. */
	commit({ epoch, ordinal, firstOrdinal, messageId }: Start): void {
		if (epoch !== this.current) {
			if (this.current !== undefined) this.retired.add(this.current);
			if (this.retired.size > 64) {
				const oldest = this.retired.values().next().value;
				if (oldest !== undefined) this.retired.delete(oldest);
			}
			this.current = epoch;
		}
		this.highWater = ordinal;
		this.live.set(messageId, { epoch, firstOrdinal });
	}

	release(messageId: string): void {
		this.live.delete(messageId);
	}
}
