import { type CompactTransition, CompactTransitionError } from "./compact-transition.ts";

type Start = Pick<
	Extract<CompactTransition, { type: "block_start" }>,
	"epoch" | "ordinal" | "firstOrdinal" | "messageId"
>;

/** R1 uses the producer's lifetime ordinal and the S05 opaque nonce, never a receipt-time identity. */
export class CompactStartIdentity {
	private current: string | undefined;
	private highWater = -1;
	private readonly live = new Map<string, { epoch: string; firstOrdinal: number }>();

	/**
	 * RULING-39: current-epoch-only. The owner's registry nonce, or without one the first committed epoch, is the only
	 * epoch it ever accepts, so no retired-nonce window exists and an old nonce can never take over.
	 */
	constructor(epoch?: string) {
		this.current = epoch;
	}

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
			(this.current !== undefined && epoch !== this.current) ||
			ordinal <= this.highWater ||
			(!binding && firstOrdinal <= this.highWater)
		)
			throw new CompactTransitionError(
				"duplicate_or_stale_start",
				"not the owner's epoch, or a stale ordinal; bootstrap a new producer epoch before restarting its counter",
			);
		if (!binding && firstOrdinal !== ordinal)
			throw new CompactTransitionError("invalid_start_identity", "a new message must bind its own first start");
	}

	/** Called only after every semantic validation and the root publication succeeded. */
	commit({ epoch, ordinal, firstOrdinal, messageId }: Start): void {
		this.current = epoch;
		this.highWater = ordinal;
		this.live.set(messageId, { epoch, firstOrdinal });
	}

	release(messageId: string): void {
		this.live.delete(messageId);
	}
}
