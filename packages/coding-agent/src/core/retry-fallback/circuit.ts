import { resolve } from "node:path";
import { parseRetryAfterMsMarker } from "@earendil-works/pi-ai/utils/retry-hint";
import type { FallbackLogger } from "./log.ts";

/**
 * Fallback-chain circuit breaker. An entry that fails out of a configured chain
 * opens a circuit keyed by its base selector (`provider/id`); while it is open,
 * chain resolution skips the entry instead of spending its retry budget again.
 *
 * One breaker is shared by every session in the process that uses the same agent
 * directory - the config that defines the providers and selectors - so a session
 * started by `/new`, `/resume`, or `/fork` (each gets a fresh model runtime) and
 * an in-process subagent do not re-discover a dead provider.
 * The class is clock-free: every call receives `now`, keeping sessions' injected
 * clocks authoritative and tests deterministic.
 */

export const DEFAULT_CIRCUIT_COOLDOWN_MS = 60_000;
export const DEFAULT_CIRCUIT_MAX_COOLDOWN_MS = 30 * 60_000;

export interface FallbackCircuitSettings {
	/** First cooldown after an entry fails out of a chain; doubles per consecutive open. 0 disables the breaker. */
	circuitCooldownMs?: number;
	circuitMaxCooldownMs?: number;
}

export interface ResolvedFallbackCircuitSettings {
	cooldownMs: number;
	maxCooldownMs: number;
}

export interface CircuitOpenRequest {
	now: number;
	cooldownMs: number;
	maxCooldownMs: number;
	retryAfterMs?: number;
}

export interface ProbeToken {
	readonly selector: string;
	readonly owner: string;
	readonly generation: number;
}

export type CircuitAdmission = { kind: "closed" } | { kind: "open" } | { kind: "probe"; token: ProbeToken };

interface SelectorCircuit {
	openUntil: number;
	retryFloorUntil: number;
	consecutiveOpens: number;
	cooldownMs: number;
	maxCooldownMs: number;
	probe: { owner: string; generation: number } | undefined;
}

function nonNegativeMs(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function resolveFallbackCircuitSettings(
	settings: FallbackCircuitSettings | undefined,
): ResolvedFallbackCircuitSettings {
	const cooldownMs = nonNegativeMs(settings?.circuitCooldownMs, DEFAULT_CIRCUIT_COOLDOWN_MS);
	const maxCooldownMs = nonNegativeMs(settings?.circuitMaxCooldownMs, DEFAULT_CIRCUIT_MAX_COOLDOWN_MS);
	return { cooldownMs, maxCooldownMs: Math.max(cooldownMs, maxCooldownMs) };
}

export class FallbackCircuitBreaker {
	private readonly circuits = new Map<string, SelectorCircuit>();
	private generations = 0;

	get size(): number {
		return this.circuits.size;
	}

	open(selector: string, request: CircuitOpenRequest): number {
		const previous = this.circuits.get(selector);
		const consecutiveOpens = (previous?.consecutiveOpens ?? 0) + 1;
		const cooldownMs = Math.min(request.cooldownMs * 2 ** (consecutiveOpens - 1), request.maxCooldownMs);
		const retryAfterMs = request.retryAfterMs;
		const hinted =
			retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
				? request.now + retryAfterMs
				: 0;
		const retryFloorUntil = Math.max(
			hinted,
			previous && previous.retryFloorUntil > request.now ? previous.retryFloorUntil : 0,
		);
		// A provider Retry-After lengthens the wait up to the ceiling, never past it. A longer
		// hint (a weekly window, or a gateway replaying a stale wait) still gets its single
		// half-open probe once the ceiling elapses, so a recovered entry is re-checked instead
		// of refused for the whole hint; a failed probe re-opens with the fresh hint (senpi#2446).
		const openUntil = Math.max(
			request.now + cooldownMs,
			Math.min(retryFloorUntil, request.now + request.maxCooldownMs),
		);
		this.circuits.set(selector, {
			openUntil,
			retryFloorUntil,
			consecutiveOpens,
			cooldownMs,
			maxCooldownMs: request.maxCooldownMs,
			probe: undefined,
		});
		return openUntil;
	}

	isOpen(selector: string, now: number, owner: string): boolean {
		const circuit = this.circuits.get(selector);
		if (!circuit) return false;
		if (now < circuit.openUntil) return true;
		return circuit.probe !== undefined && circuit.probe.owner !== owner;
	}

	/**
	 * Atomic admission: a closed selector passes, a cooling one or one whose probe
	 * another requester holds is refused, and a half-open one hands `owner` its
	 * single probe under a fresh generation. The probe stays exclusive until its
	 * token is released or the circuit settles - it never expires on a timer, so a
	 * slow probe cannot overlap a second one, and a stale token never releases a
	 * later acquisition.
	 */
	admit(selector: string, now: number, owner: string): CircuitAdmission {
		const circuit = this.circuits.get(selector);
		if (!circuit) return { kind: "closed" };
		if (now < circuit.openUntil) return { kind: "open" };
		if (circuit.probe && circuit.probe.owner !== owner) return { kind: "open" };
		circuit.probe ??= { owner, generation: ++this.generations };
		return { kind: "probe", token: { selector, owner, generation: circuit.probe.generation } };
	}

	release(token: ProbeToken): void {
		const probe = this.circuits.get(token.selector)?.probe;
		if (probe && probe.owner === token.owner && probe.generation === token.generation) {
			const circuit = this.circuits.get(token.selector);
			if (circuit) circuit.probe = undefined;
		}
	}

	releaseOwnersWithPrefix(prefix: string): void {
		for (const circuit of this.circuits.values()) {
			if (circuit.probe?.owner.startsWith(prefix)) circuit.probe = undefined;
		}
	}

	close(selector: string): void {
		this.circuits.delete(selector);
	}

	has(selector: string): boolean {
		return this.circuits.has(selector);
	}

	sweep(now: number): void {
		for (const [selector, circuit] of this.circuits) {
			if (!circuit.probe && now >= circuit.openUntil + circuit.maxCooldownMs) this.circuits.delete(selector);
		}
	}
}

/**
 * A session's requests are admitted per lane, not per session: the foreground
 * turn is one lane, each background probe-back its own. Two lanes of one session
 * never share a probe, so a probe-back in flight keeps the foreground turn off
 * the entry exactly as it keeps a sibling session off.
 */
export type CircuitLane = "turn" | `probe-back:${number}`;

export interface FallbackCircuitAccess {
	noteFailure(selector: string, failure: { retryAfterMs?: number; errorMessage?: string }): void;
	/** Whether the breaker holds any state for the selector, i.e. it, not a session cooldown, governs recovery. */
	governs(selector: string): boolean;
	isOpen(selector: string, lane?: CircuitLane): boolean;
	admit(selector: string, lane?: CircuitLane): CircuitAdmission;
	release(token: ProbeToken): void;
	releaseAll(): void;
	close(selector: string): void;
}

export interface FallbackCircuitAccessDeps {
	breaker: FallbackCircuitBreaker;
	owner(): string;
	now(): number;
	settings(): ResolvedFallbackCircuitSettings;
	logger: FallbackLogger;
}

export function createFallbackCircuitAccess(deps: FallbackCircuitAccessDeps): FallbackCircuitAccess {
	const enabled = () => deps.settings().cooldownMs > 0;
	return {
		noteFailure(selector, failure) {
			if (!enabled()) return;
			const { cooldownMs, maxCooldownMs } = deps.settings();
			const now = deps.now();
			const retryAfterMs =
				failure.retryAfterMs ??
				(failure.errorMessage === undefined ? undefined : parseRetryAfterMsMarker(failure.errorMessage));
			deps.breaker.sweep(now);
			const openUntil = deps.breaker.open(selector, { now, cooldownMs, maxCooldownMs, retryAfterMs });
			deps.logger.info("circuit_opened", { selector, durationMs: openUntil - now, retryAfterMs });
		},
		governs: (selector) => enabled() && deps.breaker.has(selector),
		isOpen: (selector, lane = "turn") =>
			enabled() && deps.breaker.isOpen(selector, deps.now(), laneOwner(deps.owner(), lane)),
		admit: (selector, lane = "turn") =>
			enabled() ? deps.breaker.admit(selector, deps.now(), laneOwner(deps.owner(), lane)) : { kind: "closed" },
		release: (token) => deps.breaker.release(token),
		releaseAll: () => deps.breaker.releaseOwnersWithPrefix(`${deps.owner()}:`),
		close: (selector) => deps.breaker.close(selector),
	};
}

function laneOwner(session: string, lane: CircuitLane): string {
	return `${session}:${lane}`;
}

interface BreakerEntry {
	readonly breaker: FallbackCircuitBreaker;
	owners: number;
}

const breakersByAgentDir = new Map<string, BreakerEntry>();

/**
 * An entry leaves the registry only when no live session holds it and it has no
 * circuit left to share; a held breaker keeps its identity however empty it is.
 */
function evictUnheldEmptyBreakers(): void {
	for (const [key, entry] of breakersByAgentDir) {
		if (entry.owners === 0 && entry.breaker.size === 0) breakersByAgentDir.delete(key);
	}
}

function entryFor(agentDir: string): BreakerEntry {
	const key = resolve(agentDir);
	let entry = breakersByAgentDir.get(key);
	if (!entry) {
		evictUnheldEmptyBreakers();
		entry = { breaker: new FallbackCircuitBreaker(), owners: 0 };
		breakersByAgentDir.set(key, entry);
	}
	return entry;
}

export function fallbackCircuitsFor(agentDir: string): FallbackCircuitBreaker {
	return entryFor(agentDir).breaker;
}

/** Holds the agent dir's breaker for one session; `release` is idempotent. */
export function acquireFallbackCircuits(agentDir: string): { breaker: FallbackCircuitBreaker; release(): void } {
	const entry = entryFor(agentDir);
	entry.owners++;
	let released = false;
	return {
		breaker: entry.breaker,
		release() {
			if (released) return;
			released = true;
			entry.owners--;
			evictUnheldEmptyBreakers();
		},
	};
}

export function monotonicNow(): number {
	return performance.timeOrigin + performance.now();
}
