export const LEAK_GRACE_MS = 1000;
export const MAX_LEAKED_WORKERS = 3;
const BREAKER_OPEN_AFTER = 2;
export const BREAKER_BACKOFF_MS = 5000;
export const BREAKER_BACKOFF_MAX_MS = 60_000;

export type BreakerState = "closed" | "open" | "half-open";

export interface ResolverStateEvent {
	readonly volumeKey: string;
	readonly state: BreakerState | "leak-cap" | "leak-recovered" | "unavailable";
	readonly leaked: number;
}

export type ResolverStateEmitter = (volumeKey: string, state: ResolverStateEvent["state"]) => void;

interface Breaker {
	state: BreakerState;
	consecutive: number;
	backoffMs: number;
	probe?: ReturnType<typeof setTimeout>;
}

export interface BreakerRegistry {
	breakerFor(key: string): Breaker;
	recordTimeout(key: string): void;
	recordSuccess(key: string): void;
	stateOf(key: string): BreakerState;
	clearProbes(): void;
}

/** Per-volume breakers: open after consecutive timeouts, half-open after a doubling back-off, closed on a probe. */
export function createBreakerRegistry(
	emit: ResolverStateEmitter,
	atLeakCap: () => boolean,
	onClosed: () => void,
): BreakerRegistry {
	const breakers = new Map<string, Breaker>();

	const breakerFor = (key: string): Breaker => {
		let breaker = breakers.get(key);
		if (!breaker) {
			breaker = { state: "closed", consecutive: 0, backoffMs: BREAKER_BACKOFF_MS };
			breakers.set(key, breaker);
		}
		return breaker;
	};

	const scheduleProbe = (key: string, breaker: Breaker) => {
		breaker.probe = setTimeout(() => {
			breaker.probe = undefined;
			if (breaker.state !== "open") return;
			if (atLeakCap()) {
				scheduleProbe(key, breaker);
				return;
			}
			breaker.state = "half-open";
			emit(key, "half-open");
		}, breaker.backoffMs);
		breaker.probe.unref?.();
	};

	const recordTimeout = (key: string) => {
		const breaker = breakerFor(key);
		breaker.consecutive += 1;
		if (breaker.state === "half-open" || breaker.consecutive >= BREAKER_OPEN_AFTER) {
			if (breaker.state === "half-open") breaker.backoffMs = Math.min(breaker.backoffMs * 2, BREAKER_BACKOFF_MAX_MS);
			breaker.state = "open";
			emit(key, "open");
			scheduleProbe(key, breaker);
		}
	};

	const recordSuccess = (key: string) => {
		const breaker = breakerFor(key);
		const was = breaker.state;
		breaker.consecutive = 0;
		breaker.state = "closed";
		breaker.backoffMs = BREAKER_BACKOFF_MS;
		if (was !== "closed") {
			emit(key, "closed");
			onClosed();
		}
	};

	return {
		breakerFor,
		recordTimeout,
		recordSuccess,
		stateOf: (key) => breakers.get(key)?.state ?? "closed",
		clearProbes: () => {
			for (const breaker of breakers.values()) clearTimeout(breaker.probe);
		},
	};
}

export interface AbandonedWorkerCount {
	readonly count: number;
	readonly atCap: boolean;
	/** Counts a retired worker as abandoned when its `terminate()` has not returned after the grace, and uncounts it when it does. */
	track(terminated: Promise<unknown>): void;
}

export function createAbandonedWorkerCount(emit: ResolverStateEmitter): AbandonedWorkerCount {
	let leaked = 0;
	return {
		get count() {
			return leaked;
		},
		get atCap() {
			return leaked >= MAX_LEAKED_WORKERS;
		},
		track(terminated) {
			let counted = false;
			const grace = setTimeout(() => {
				counted = true;
				leaked += 1;
				if (leaked >= MAX_LEAKED_WORKERS) emit("process", "leak-cap");
			}, LEAK_GRACE_MS);
			grace.unref?.();
			void terminated.then(
				() => {
					clearTimeout(grace);
					if (counted) {
						leaked -= 1;
						emit("process", "leak-recovered");
					}
				},
				() => {},
			);
		},
	};
}
