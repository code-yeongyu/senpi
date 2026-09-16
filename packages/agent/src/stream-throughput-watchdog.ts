/**
 * Rate guard for an in-progress provider stream.
 *
 * Every other guard on a live stream is a SILENCE detector: the stream-start
 * bound stops applying once the first event arrived, and the inter-event idle
 * bound is re-armed by every event. A provider that keeps answering at ~2 tok/s
 * therefore trips nothing at all, while the session is unusable — the reported
 * `gpt-6-astra` symptom (#1739). This measures the RATE of streamed text and
 * thinking units so a trickle becomes a first-class, retryable failure instead
 * of a healthy-looking turn.
 *
 * Deliberately not a wall-clock turn budget: tool-using turns legitimately last
 * many minutes. Only time spent waiting on the provider counts, and time the
 * provider spends executing local work (Cursor's exec channel) is excluded.
 */

/** Sustained floor in streamed units per second; `0` disables the watchdog. */
export const DEFAULT_STREAM_THROUGHPUT_FLOOR_TOKENS_PER_SECOND = 8;
/** Observation window; the verdict needs a full window of measured streaming. */
export const DEFAULT_STREAM_THROUGHPUT_WINDOW_MS = 20_000;
/** First-token jitter and a single long reasoning pause must not fire. */
export const DEFAULT_STREAM_THROUGHPUT_GRACE_MS = 5_000;
/**
 * Minimum streamed units inside the window before a rate is judged at all, so a
 * two-token heartbeat is never divided into a verdict.
 */
export const STREAM_THROUGHPUT_MIN_UNITS = 16;
/** Live rate needs this much measured streaming before it means anything. */
const MIN_RATE_SAMPLE_MS = 1_000;

export interface StreamThroughputOptions {
	/** Sustained floor in units per second; `0` or negative disables the watchdog. */
	floorTokensPerSecond?: number;
	/** Observation window in milliseconds; `0` or negative disables the watchdog. */
	windowMs?: number;
	/** Milliseconds after the first stream event that are never measured. */
	graceMs?: number;
}

/**
 * One unit approximates one token. Providers that emit a delta per token give
 * one unit per delta; gateways that batch several tokens into one delta are
 * measured by length instead of by event count, so batching cannot be mistaken
 * for a trickle.
 */
export function estimateStreamedUnits(text: string | undefined): number {
	if (!text) return 0;
	return Math.max(1, Math.ceil(text.length / 4));
}

function formatRate(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatWindowSeconds(windowMs: number): string {
	const seconds = windowMs / 1000;
	return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
}

/**
 * The wording is part of the contract: `packages/ai/src/utils/retry.ts`
 * classifies it as a retryable, throughput-degraded failure (distinct from the
 * silence stalls), and the session routes it straight to the fallback chain.
 */
export function formatStreamThroughputDegradedMessage(
	tokensPerSecond: number,
	floorTokensPerSecond: number,
	windowMs: number,
): string {
	return (
		`Provider stream throughput degraded: ${formatRate(tokensPerSecond)} tok/s over ` +
		`${formatWindowSeconds(windowMs)}s (floor ${formatRate(floorTokensPerSecond)} tok/s) ` +
		`(lower or disable with retry.provider.minThroughputTokensPerSecond in senpi settings; 0 disables)`
	);
}

export class StreamThroughputDegradedError extends Error {
	readonly tokensPerSecond: number;
	readonly floorTokensPerSecond: number;
	readonly windowMs: number;

	constructor(tokensPerSecond: number, floorTokensPerSecond: number, windowMs: number) {
		super(formatStreamThroughputDegradedMessage(tokensPerSecond, floorTokensPerSecond, windowMs));
		this.name = "StreamThroughputDegradedError";
		this.tokensPerSecond = tokensPerSecond;
		this.floorTokensPerSecond = floorTokensPerSecond;
		this.windowMs = windowMs;
	}
}

/**
 * Sliding-window counter of streamed units over the time actually spent
 * waiting on the provider. Shared by the watchdog and by the interactive
 * working status, so the rate a user sees is the rate that gets judged.
 */
export class StreamRateMeter {
	private readonly windowMs: number;
	private readonly now: () => number;
	private samples: { at: number; units: number }[] = [];
	private unitsInWindow = 0;
	private excludedMs = 0;
	private originMs: number | undefined;

	constructor(windowMs: number, now: () => number = Date.now) {
		this.windowMs = windowMs;
		this.now = now;
	}

	/** Wall clock minus the spans excluded from measurement; monotonic. */
	measuredNow(): number {
		return this.now() - this.excludedMs;
	}

	/** Measured time since the first stream event, or undefined before it. */
	measuredElapsedMs(): number | undefined {
		return this.originMs === undefined ? undefined : this.measuredNow() - this.originMs;
	}

	/** Anchor the measurement at the first stream event. Idempotent. */
	start(): void {
		if (this.originMs === undefined) this.originMs = this.measuredNow();
	}

	/** Drop a span of wall-clock time (provider-local tool work) from the measurement. */
	exclude(elapsedMs: number): void {
		if (elapsedMs > 0) this.excludedMs += elapsedMs;
	}

	record(units: number): void {
		if (units <= 0) return;
		this.start();
		const at = this.measuredNow();
		this.samples.push({ at, units });
		this.unitsInWindow += units;
		this.prune(at);
	}

	/** Streamed units inside the trailing window. */
	units(): number {
		this.prune(this.measuredNow());
		return this.unitsInWindow;
	}

	/**
	 * Units per second over the trailing window, or undefined until enough
	 * measured streaming exists for the number to mean anything.
	 */
	ratePerSecond(): number | undefined {
		const elapsedMs = this.measuredElapsedMs();
		if (elapsedMs === undefined) return undefined;
		const spanMs = Math.min(this.windowMs, elapsedMs);
		if (spanMs < MIN_RATE_SAMPLE_MS) return undefined;
		const units = this.units();
		if (units <= 0) return 0;
		return units / (spanMs / 1000);
	}

	reset(): void {
		this.samples = [];
		this.unitsInWindow = 0;
		this.excludedMs = 0;
		this.originMs = undefined;
	}

	private prune(at: number): void {
		const cutoff = at - this.windowMs;
		let dropped = 0;
		while (dropped < this.samples.length && this.samples[dropped].at < cutoff) {
			this.unitsInWindow -= this.samples[dropped].units;
			dropped++;
		}
		if (dropped > 0) this.samples = this.samples.slice(dropped);
	}
}

export interface StreamThroughputWatchdog {
	/** Marks the first stream event; starts the grace clock. Idempotent. */
	start(): void;
	/** Records streamed units and returns the verdict when the floor is breached. */
	record(units: number): StreamThroughputDegradedError | undefined;
	/** Drops a span of wall-clock time (provider-local tool work) from the measurement. */
	exclude(elapsedMs: number): void;
	/** Live rate over the window, or undefined while it is still meaningless. */
	ratePerSecond(): number | undefined;
}

/**
 * Returns undefined when the watchdog is disabled (a floor or window of `0`),
 * so the caller can skip the measurement entirely.
 */
export function createStreamThroughputWatchdog(
	options: StreamThroughputOptions | undefined,
	now: () => number = Date.now,
): StreamThroughputWatchdog | undefined {
	const floorTokensPerSecond = options?.floorTokensPerSecond ?? DEFAULT_STREAM_THROUGHPUT_FLOOR_TOKENS_PER_SECOND;
	const windowMs = options?.windowMs ?? DEFAULT_STREAM_THROUGHPUT_WINDOW_MS;
	const graceMs = Math.max(0, options?.graceMs ?? DEFAULT_STREAM_THROUGHPUT_GRACE_MS);
	if (!Number.isFinite(floorTokensPerSecond) || floorTokensPerSecond <= 0) return undefined;
	if (!Number.isFinite(windowMs) || windowMs <= 0) return undefined;

	const meter = new StreamRateMeter(windowMs, now);
	return {
		start: () => meter.start(),
		exclude: (elapsedMs: number) => meter.exclude(elapsedMs),
		ratePerSecond: () => meter.ratePerSecond(),
		record: (units: number) => {
			meter.record(units);
			const elapsedMs = meter.measuredElapsedMs();
			// Judge only on a full window of measured streaming that starts after
			// the grace period; anything earlier is jitter, not a sustained rate.
			if (elapsedMs === undefined || elapsedMs < graceMs + windowMs) return undefined;
			const unitsInWindow = meter.units();
			if (unitsInWindow < STREAM_THROUGHPUT_MIN_UNITS) return undefined;
			const tokensPerSecond = unitsInWindow / (windowMs / 1000);
			if (tokensPerSecond >= floorTokensPerSecond) return undefined;
			return new StreamThroughputDegradedError(tokensPerSecond, floorTokensPerSecond, windowMs);
		},
	};
}
