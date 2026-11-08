/**
 * Waits on the device route (row CK9; custody design 2.3 "Pause = tracked local work", 4.2 live digests, 4.4). A wait
 * is never a thrown value: it is bracketed by the host's `onWait`/`onWaitEnd` (W7, `step.waiting`) and held in the
 * stream's `trackLocalWork`, so the loop's idle watchdog re-arms instead of failing the step. A user abort releases the
 * wait at once.
 */
import type {
	DeviceId,
	EgressHostHooks,
	EgressWait,
	ProviderId,
	StepRef,
	WaitCondition,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { HandPresence } from "./wire.ts";

export interface EgressClock {
	now(): number;
	/** Resolves after `ms`, or rejects with the signal's reason once it aborts. */
	sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface WaitConditionSource {
	/** Resolves once any of `waitFor` holds (device online, user choice made, ...), or rejects when `signal` aborts. */
	until(waitFor: readonly WaitCondition[], signal: AbortSignal): Promise<void>;
}

const abortions = new WeakMap<AbortSignal, Promise<never>>();

/**
 * A promise that rejects with the abort reason as soon as `signal` aborts; it never resolves. One promise (and one
 * listener) per signal, however many waits race it: an indefinite key backoff must not pile up abort listeners.
 */
export function abortion(signal: AbortSignal): Promise<never> {
	const known = abortions.get(signal);
	if (known) return known;
	const { promise, reject } = Promise.withResolvers<never>();
	if (signal.aborted) reject(signal.reason);
	else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	promise.catch(() => {});
	abortions.set(signal, promise);
	return promise;
}

const raceAbort = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> => Promise.race([work, abortion(signal)]);

export interface StepWaits {
	/** Holds `work` as a tracked wait of the current step until it settles. */
	hold<T>(wait: Omit<EgressWait, "call">, work: Promise<T>): Promise<T>;
}

export function stepWaits(
	stream: AssistantMessageEventStream,
	host: EgressHostHooks,
	step: StepRef,
	signal: AbortSignal,
): StepWaits {
	return {
		async hold(wait, work) {
			await host.onWait({ ...wait, call: step });
			try {
				return await stream.trackLocalWork(raceAbort(work, signal));
			} finally {
				await host.onWaitEnd(step.stepId);
			}
		},
	};
}

/** Registry-key backoff while the hand cannot check the key: 5 s doubling to a 5 minute cap, indefinitely (4.6). */
export const nextKeyBackoffMs = (previous: number | undefined): number =>
	previous === undefined ? 5_000 : Math.min(previous * 2, 300_000);

export interface LiveDigestBoard {
	report(presence: HandPresence): void;
	digest(deviceId: DeviceId, providerId: ProviderId): string | undefined;
	/** Resolves with the new digest the next time the device reports a value DIFFERENT from its last one (4.2). */
	changed(deviceId: DeviceId, providerId: ProviderId, signal: AbortSignal): Promise<string>;
}

export function createLiveDigestBoard(): LiveDigestBoard {
	const digests = new Map<string, string>();
	const waiters = new Map<string, Set<(digest: string) => void>>();
	const keyOf = (deviceId: DeviceId, providerId: ProviderId): string => JSON.stringify([deviceId, providerId]);
	return {
		report(presence) {
			for (const [providerId, digest] of Object.entries(presence.liveDigests ?? {})) {
				const key = keyOf(presence.deviceId, providerId);
				const previous = digests.get(key);
				digests.set(key, digest);
				if (previous === digest) continue;
				const woken = waiters.get(key);
				waiters.delete(key);
				for (const wake of woken ?? []) wake(digest);
			}
		},
		digest: (deviceId, providerId) => digests.get(keyOf(deviceId, providerId)),
		changed(deviceId, providerId, signal) {
			const key = keyOf(deviceId, providerId);
			const { promise, resolve } = Promise.withResolvers<string>();
			const set = waiters.get(key) ?? new Set();
			set.add(resolve);
			waiters.set(key, set);
			signal.addEventListener("abort", () => set.delete(resolve), { once: true });
			return raceAbort(promise, signal);
		},
	};
}
