/**
 * Background OAuth refresh loop for the auth-broker server.
 *
 * Iterates active OAuth credentials at `refreshIntervalMs` cadence, refreshing
 * any whose access token expires within `refreshSkewMs`. The single-flight,
 * disable-on-definitive-failure, and CAS semantics all live inside
 * {@link AuthBrokerService.sweepExpiringCredentials}; this class only owns the
 * timer and clock so it is trivially deterministic in tests. The sweep is a
 * no-op when the broker has no refresh callback configured, so a freshly-booted
 * broker without refresh wiring stays inert rather than throwing on every tick.
 */
import type { AuthBrokerService } from "./auth-broker.ts";

export const DEFAULT_AUTH_BROKER_REFRESH_SKEW_MS = 5 * 60 * 1000;
export const DEFAULT_AUTH_BROKER_REFRESH_INTERVAL_MS = 60 * 1000;

export interface AuthBrokerRefresherOptions {
	readonly service: AuthBrokerService;
	/** Refresh credentials expiring within this window. Default 5 min. */
	readonly refreshSkewMs?: number;
	/** Loop cadence. Default 60s. */
	readonly refreshIntervalMs?: number;
	/** Override clock (tests). */
	readonly now?: () => number;
}

export interface AuthBrokerRefresherSchedule {
	readonly enabled: boolean;
	readonly intervalMs: number;
	readonly skewMs: number;
	readonly nextSweepAt: number;
}

export class AuthBrokerRefresher {
	readonly #service: AuthBrokerService;
	readonly #refreshSkewMs: number;
	readonly #refreshIntervalMs: number;
	readonly #now: () => number;
	#timer: ReturnType<typeof setInterval> | undefined;
	#running = false;
	#nextSweepAt: number;
	#activeTick: Promise<void> | undefined;
	#startPromise: Promise<void> | undefined;

	constructor(opts: AuthBrokerRefresherOptions) {
		this.#service = opts.service;
		this.#refreshSkewMs = opts.refreshSkewMs ?? DEFAULT_AUTH_BROKER_REFRESH_SKEW_MS;
		this.#refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_AUTH_BROKER_REFRESH_INTERVAL_MS;
		this.#now = opts.now ?? Date.now;
		this.#nextSweepAt = this.#now();
	}

	async start(): Promise<void> {
		if (this.#timer !== undefined) return;
		const existing = this.#startPromise;
		if (existing !== undefined) return existing;
		const starting = this.startOnce();
		this.#startPromise = starting;
		try {
			await starting;
		} finally {
			if (this.#startPromise === starting) this.#startPromise = undefined;
		}
	}

	async stop(): Promise<void> {
		const starting = this.#startPromise;
		if (starting !== undefined) await starting.catch(() => undefined);
		if (this.#timer !== undefined) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
		const active = this.#activeTick;
		if (active !== undefined) await active.catch(() => undefined);
	}

	private async startOnce(): Promise<void> {
		this.#nextSweepAt = this.#now();
		await this.tick();
		this.#timer = setInterval(() => {
			void this.tick();
		}, this.#refreshIntervalMs);
	}

	getSchedule(): AuthBrokerRefresherSchedule {
		return {
			enabled: this.#timer !== undefined,
			intervalMs: this.#refreshIntervalMs,
			skewMs: this.#refreshSkewMs,
			nextSweepAt: this.#nextSweepAt,
		};
	}

	/** Run one sweep. Exposed for tests. */
	async tick(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		const sweep = this.#service
			.sweepExpiringCredentials({ now: this.#now(), refreshSkewMs: this.#refreshSkewMs })
			.then(
				() => undefined,
				() => undefined,
			);
		this.#activeTick = sweep;
		try {
			await sweep;
		} finally {
			this.#running = false;
			this.#nextSweepAt = this.#now() + this.#refreshIntervalMs;
			this.#activeTick = undefined;
		}
	}
}
