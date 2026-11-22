/**
 * The hop count of a thread chain (brain/hand split, decision K8): session A's thread tool prompts session B, B's
 * prompts A again, and so on. A→B→A is allowed. Each call carries the count of the hop it makes; a session started by
 * a thread call is at that call's count, and its own thread calls carry one more. The only limit is a count the user
 * sets; unset means unlimited. There is no cost limit, no hidden default and no refusal for coming back to an origin.
 */

/** The refusal reason of a thread call past the user's count limit. */
export const CHAIN_COUNT_LIMIT = "chain_count_limit";

/** A user-started session is at count 0; its first thread call is hop 1. */
export const CHAIN_ORIGIN = 0;

export class ChainCountLimitError extends Error {
	readonly reason = CHAIN_COUNT_LIMIT;
	readonly count: number;
	readonly limit: number;

	constructor(count: number, limit: number) {
		super(`This thread call would be hop ${count} of its chain; your thread chain count limit is ${limit}.`);
		this.name = "ChainCountLimitError";
		this.count = count;
		this.limit = limit;
	}
}

const isCount = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The count a thread call sent from a session at `sessionCount` carries. */
export function nextChainCount(sessionCount: number): number {
	if (!isCount(sessionCount)) throw new TypeError(`not a chain count: ${String(sessionCount)}`);
	return sessionCount + 1;
}

/** Parses the count a thread call carries; absent means the call starts a chain (hop 1 from a user-started session). */
export function decodeChainCount(value: unknown): number {
	if (value === undefined) return nextChainCount(CHAIN_ORIGIN);
	if (!isCount(value) || value === CHAIN_ORIGIN)
		throw new TypeError(`malformed chain count: ${JSON.stringify(value)}`);
	return value;
}

/**
 * Admits a thread call that makes its chain `count` hops long. `readLimit` is read at each admission, never cached
 * (on the CLI: the user's `threads.chainCountLimit` setting); `undefined` admits every call at any length.
 */
export function admitChainCall(count: number, readLimit: () => number | undefined): number {
	const limit = readLimit();
	if (limit !== undefined && count > limit) throw new ChainCountLimitError(count, limit);
	return count;
}
