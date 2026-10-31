/**
 * Prompt caches are per organization and every subscription seat is its own organization, so a turn sent
 * to any seat other than the one holding the session's cache (the warm seat) re-sends the whole
 * conversation uncached. A turn may pay that once: this remembers the one cold seat each session's current
 * turn used, so the session's own retries of that turn do not seed it, or another seat, again
 * (oh-my-openagent#10304).
 */

/** Sessions whose current turn a long-lived host remembers; the oldest-touched is dropped past it. */
const MAX_TRACKED_SESSIONS = 256;
/** A seat's copy of the prefix lasts no longer than the subscription lane's 1h prompt cache, so the record does not either. */
const COLD_SEAT_RECORD_TTL_MS = 60 * 60 * 1_000;
const coldSeatByTurn = new Map<string, { turnKey: string; seat: string; recordedAt: number }>();

export function spentColdSeat(
	sessionKey: string | undefined,
	turnKey: string | undefined,
	now: number,
): string | undefined {
	if (sessionKey === undefined || turnKey === undefined) return undefined;
	const spent = coldSeatByTurn.get(sessionKey);
	return spent?.turnKey === turnKey && now - spent.recordedAt < COLD_SEAT_RECORD_TTL_MS ? spent.seat : undefined;
}

export function recordColdSeat(
	sessionKey: string | undefined,
	turnKey: string | undefined,
	seat: string,
	now: number,
): void {
	if (sessionKey === undefined || turnKey === undefined) return;
	coldSeatByTurn.delete(sessionKey);
	coldSeatByTurn.set(sessionKey, { turnKey, seat, recordedAt: now });
	const oldest = coldSeatByTurn.keys().next().value;
	if (coldSeatByTurn.size > MAX_TRACKED_SESSIONS && oldest !== undefined) coldSeatByTurn.delete(oldest);
}

/** A served turn ends the turn's budget. Without a session key, clears every session (tests). */
export function forgetColdSeat(sessionKey?: string): void {
	if (sessionKey === undefined) coldSeatByTurn.clear();
	else coldSeatByTurn.delete(sessionKey);
}

/**
 * The turn stops instead of seeding another seat: the warm seat cannot serve it now and the one cold seat
 * this turn may use has failed. The next turn may try one cold seat again.
 */
export class ColdSeedLimitError extends Error {
	readonly warmAccount: string;
	readonly coldAccount: string;
	/** When the warm or tried cold seat is due back, only if no account can serve the next turn now. */
	readonly soonestUnblockAt: number | undefined;

	constructor(warmAccount: string, coldAccount: string, soonestUnblockAt: number | undefined) {
		const until = soonestUnblockAt === undefined ? undefined : new Date(soonestUnblockAt).toISOString();
		super(
			`Anthropic Subscription stopped this turn instead of moving it to a third account: the account that holds this session's prompt cache (${warmAccount}) cannot serve it${until === undefined ? "" : ` (due back by ${until})`}, and the one other account a turn may try (${coldAccount}) failed too. Each further account would re-send the whole conversation without a cache. The next turn may try one other account again.`,
		);
		this.name = "ColdSeedLimitError";
		this.warmAccount = warmAccount;
		this.coldAccount = coldAccount;
		this.soonestUnblockAt = soonestUnblockAt;
	}
}
