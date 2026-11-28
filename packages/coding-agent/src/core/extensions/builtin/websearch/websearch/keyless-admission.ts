import { hasFunctions, realmRegistry } from "@earendil-works/pi-realm-registry";
import type { SearchBlockReason } from "./types.ts";

/** First cooldown after a keyless engine blocks a search; each consecutive block doubles it up to the cap. */
export const ENGINE_COOLDOWN_BASE_MS = 60_000;
export const ENGINE_COOLDOWN_MAX_MS = 15 * 60_000;
/** Requests one keyless engine may have in flight at once across every caller sharing the admission. */
export const KEYLESS_MAX_IN_FLIGHT = 2;

export interface EngineCooldown {
	failures: number;
	until: number;
	reason: SearchBlockReason;
}

export type KeylessOutcome =
	| { readonly kind: "success" }
	| { readonly kind: "blocked"; readonly reason: SearchBlockReason; readonly retryAfterSeconds?: number }
	| { readonly kind: "failed" };

/**
 * Admission to the anonymous capacity of keyless search engines, keyed by provider entry label (senpi#4178).
 *
 * Every web_search tool in a realm shares one instance, so parallel child sessions (each with its own resource
 * loader and tool) see one cooldown per engine and one in-flight bound instead of bursting at it independently.
 * Scope is the process's JavaScript realm: other processes, workers and `vm` contexts keep their own.
 */
export interface KeylessAdmission {
	cooldown(key: string, now: number): EngineCooldown | undefined;
	/**
	 * Waits for an in-flight slot (one while the engine recovers from a block, else `KEYLESS_MAX_IN_FLIGHT`) and
	 * returns its release. Rejects with the signal's reason when the caller aborts while waiting.
	 */
	acquire(key: string, signal?: AbortSignal): Promise<() => void>;
	/** A block starts or doubles the cooldown (honoring Retry-After up to the cap); a success clears it. */
	record(key: string, outcome: KeylessOutcome, now: number): void;
}

interface EngineAdmission {
	inFlight: number;
	cooldown: EngineCooldown | undefined;
	readonly waiters: Array<() => void>;
}

export function createKeylessAdmission(): KeylessAdmission {
	const engines = new Map<string, EngineAdmission>();
	const engine = (key: string): EngineAdmission => {
		let state = engines.get(key);
		if (!state) {
			state = { inFlight: 0, cooldown: undefined, waiters: [] };
			engines.set(key, state);
		}
		return state;
	};
	// A recovering engine (one with a recorded block) gets a single probe before it takes parallel traffic again.
	const capacity = (state: EngineAdmission) => (state.cooldown ? 1 : KEYLESS_MAX_IN_FLIGHT);
	const wake = (state: EngineAdmission) => {
		while (state.inFlight < capacity(state)) {
			const next = state.waiters.shift();
			if (!next) return;
			next();
		}
	};
	const slot = (state: EngineAdmission) => {
		state.inFlight += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			state.inFlight -= 1;
			wake(state);
		};
	};
	return {
		cooldown(key, now) {
			const cooldown = engines.get(key)?.cooldown;
			return cooldown && cooldown.until > now ? cooldown : undefined;
		},
		acquire(key, signal) {
			const state = engine(key);
			if (signal?.aborted) return Promise.reject(signal.reason);
			if (state.inFlight < capacity(state) && state.waiters.length === 0) return Promise.resolve(slot(state));
			return new Promise((resolve, reject) => {
				const admit = () => {
					signal?.removeEventListener("abort", abort);
					resolve(slot(state));
				};
				const abort = () => {
					const index = state.waiters.indexOf(admit);
					if (index !== -1) state.waiters.splice(index, 1);
					reject(signal?.reason);
				};
				state.waiters.push(admit);
				signal?.addEventListener("abort", abort, { once: true });
			});
		},
		record(key, outcome, now) {
			const state = engine(key);
			if (outcome.kind === "success") {
				state.cooldown = undefined;
				wake(state);
				return;
			}
			if (outcome.kind !== "blocked") return;
			const failures = (state.cooldown?.failures ?? 0) + 1;
			const backoff = Math.min(ENGINE_COOLDOWN_MAX_MS, ENGINE_COOLDOWN_BASE_MS * 2 ** (failures - 1));
			const requested = Math.min(ENGINE_COOLDOWN_MAX_MS, (outcome.retryAfterSeconds ?? 0) * 1000);
			state.cooldown = { failures, until: now + Math.max(backoff, requested), reason: outcome.reason };
		},
	};
}

export function sharedKeylessAdmission(): KeylessAdmission {
	return realmRegistry(
		"@code-yeongyu/senpi/websearch-keyless-admission/v1",
		createKeylessAdmission,
		(value): value is KeylessAdmission => hasFunctions(value, ["cooldown", "acquire", "record"]),
	);
}
