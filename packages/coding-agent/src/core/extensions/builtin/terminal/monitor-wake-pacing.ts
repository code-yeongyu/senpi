/**
 * Per-monitor wake pacing: a token bucket of `rate` tokens refilled at `rate` an hour, one token
 * per wake. Monitors without a rate are unpaced and always ready.
 */
const HOUR_MS = 3_600_000;

interface Bucket {
	tokens: number;
	at: number;
}

export class WakePacer {
	readonly #rateOf: (id: string) => number | undefined;
	readonly #buckets = new Map<string, Bucket>();

	constructor(rateOf: (id: string) => number | undefined) {
		this.#rateOf = rateOf;
	}

	/** When `id` next holds a whole token: `now` for an unpaced monitor or one with a token left. */
	readyAt(id: string, now: number): number {
		const paced = this.#refill(id, now);
		if (paced === undefined || paced.bucket.tokens >= 1) return now;
		return now + Math.ceil(((1 - paced.bucket.tokens) * HOUR_MS) / paced.rate);
	}

	spend(id: string, now: number): void {
		const paced = this.#refill(id, now);
		if (paced !== undefined) paced.bucket.tokens = Math.max(0, paced.bucket.tokens - 1);
	}

	forget(id: string): void {
		this.#buckets.delete(id);
	}

	clear(): void {
		this.#buckets.clear();
	}

	#refill(id: string, now: number): { bucket: Bucket; rate: number } | undefined {
		const rate = this.#rateOf(id);
		if (rate === undefined || !Number.isFinite(rate) || rate < 1) return undefined;
		const bucket = this.#buckets.get(id) ?? { tokens: rate, at: now };
		bucket.tokens = Math.min(rate, bucket.tokens + ((now - bucket.at) * rate) / HOUR_MS);
		bucket.at = now;
		this.#buckets.set(id, bucket);
		return { bucket, rate };
	}
}
