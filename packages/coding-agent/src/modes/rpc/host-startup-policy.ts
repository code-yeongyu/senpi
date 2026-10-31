/**
 * The startup readiness policy of a spawned RPC host (senpi#4602, design A-amended): one controller
 * per start attempt decides, on its own monotonic clock, whether the attempt is READY or has failed.
 *
 * Each phase gets a finite allowance from the moment it is entered; every deadline is clipped to
 * `STARTUP_DECISION_BUDGET_MS` after spawn. Only the completion of the current phase grants the next
 * phase its allowance: a replayed milestone, a heartbeat or a same-phase event adds no time. The
 * clock is sampled at every ingress, so an event that arrives at or after the deadline loses to it.
 */
import { SIGKILL_GRACE_MS } from "./host-ensure-stop.ts";
import { DEFAULT_CHILD_STALLED_STOP_MAX_MS } from "./host-stalled-evidence.ts";
import { CHILD_KILL_EXIT_TIMEOUT_MS, CHILD_STOP_TIMEOUT_MS } from "./host-stop-intent.ts";

/** G: spawn to ready-or-failed decision. */
export const STARTUP_DECISION_BUDGET_MS = 180_000;

export type StartupPhase =
	| "supervisor_bootstrap"
	| "supervisor_setup"
	| "host_bootstrap"
	| "host_runtime"
	| "internal_ready"
	| "observer_ready"
	| "public_published"
	| "presenter_resolved"
	| "public_verified";

export const STARTUP_PHASE_ALLOWANCE_MS: Readonly<Record<StartupPhase, number>> = {
	supervisor_bootstrap: 30_000,
	supervisor_setup: 15_000,
	host_bootstrap: 30_000,
	host_runtime: 60_000,
	internal_ready: 15_000,
	observer_ready: 15_000,
	public_published: 15_000,
	presenter_resolved: 30_000,
	public_verified: 10_000,
};

export type StartupLaunchKind = "initial" | "successor";

const SHARED_PREFIX: readonly StartupPhase[] = [
	"supervisor_bootstrap",
	"supervisor_setup",
	"host_bootstrap",
	"host_runtime",
	"internal_ready",
	"observer_ready",
];

/** A successor enrolls its presenter before it may take the predecessor's public endpoint. */
const PHASE_PATH: Readonly<Record<StartupLaunchKind, readonly StartupPhase[]>> = {
	initial: [...SHARED_PREFIX, "public_published", "presenter_resolved", "public_verified"],
	successor: [...SHARED_PREFIX, "presenter_resolved", "public_published", "public_verified"],
};

export interface StartupClock {
	now(): number;
	scheduleAt(at: number, fire: () => void): unknown;
	cancel(handle: unknown): void;
}

export type StartupTimeout = {
	readonly kind: "timeout";
	readonly phase: StartupPhase;
	readonly limit: "phase" | "overall";
	readonly phaseBudgetMs: number;
	readonly elapsedMs: number;
};

export type StartupOutcome =
	| { readonly kind: "ready"; readonly elapsedMs: number }
	| StartupTimeout
	| { readonly kind: "failed"; readonly phase: StartupPhase; readonly cause: Error; readonly elapsedMs: number };

export interface StartupController {
	/** `ignored`: a replay of a completed phase; `rejected`: terminal, expired, or not the current phase. */
	complete(phase: StartupPhase): "accepted" | "ignored" | "rejected";
	fail(cause: Error): void;
	readonly terminal: StartupOutcome | undefined;
}

/** Create the controller immediately BEFORE spawning: its creation instant is the spawn origin. */
export function startStartupController(options: {
	readonly launchKind: StartupLaunchKind;
	readonly clock: StartupClock;
}): StartupController {
	const { clock } = options;
	const path = PHASE_PATH[options.launchKind];
	const t0 = clock.now();
	const ceiling = t0 + STARTUP_DECISION_BUDGET_MS;
	let index = 0;
	let phaseLimit = 0;
	let deadline = 0;
	let timer: unknown;
	let terminal: StartupOutcome | undefined;

	const current = (): StartupPhase => path[Math.min(index, path.length - 1)] ?? "supervisor_bootstrap";
	const settle = (outcome: StartupOutcome): void => {
		if (terminal) return;
		terminal = outcome;
		clock.cancel(timer);
	};
	const expire = (): void => {
		const phase = current();
		settle({
			kind: "timeout",
			phase,
			limit: phaseLimit <= ceiling ? "phase" : "overall",
			phaseBudgetMs: STARTUP_PHASE_ALLOWANCE_MS[phase],
			elapsedMs: deadline - t0,
		});
	};
	const enter = (at: number): void => {
		phaseLimit = at + STARTUP_PHASE_ALLOWANCE_MS[current()];
		deadline = Math.min(phaseLimit, ceiling);
		timer = clock.scheduleAt(deadline, expire);
	};
	/** Ingress sampling: at or past the deadline, expiry wins over whatever just arrived. */
	const expiredAt = (now: number): boolean => {
		if (!terminal && now >= deadline) expire();
		return terminal !== undefined;
	};

	enter(t0);
	return {
		complete(phase) {
			const now = clock.now();
			if (expiredAt(now)) return "rejected";
			const position = path.indexOf(phase);
			if (position >= 0 && position < index) return "ignored";
			if (position !== index) return "rejected";
			clock.cancel(timer);
			index += 1;
			if (index === path.length) settle({ kind: "ready", elapsedMs: now - t0 });
			else enter(now);
			return "accepted";
		},
		fail(cause) {
			const now = clock.now();
			if (expiredAt(now)) return;
			settle({ kind: "failed", phase: current(), cause, elapsedMs: now - t0 });
		},
		get terminal() {
			return terminal;
		},
	};
}

/** The fixed reap/record margin of the existing stop path, beside its SIGTERM, kill-exit and SIGKILL waits. */
const STOP_REAP_MARGIN_MS = 5_000;
/** Probe disposal and guarded record bookkeeping after a failed start. */
const FAILED_START_FINALIZE_MS = 2_000 + 5_000;
/** D: one pooled allocation for discovery, ownership observations, legacy reads and pre-spawn writes. */
const DISCOVERY_BUDGET_MS = 90_000;
const LOCK_WAIT_HEADROOM_MS = 10_000;
const HANDOVER_REPLY_MARGIN_MS = 20_000;

/**
 * The numerical envelope every startup-adjacent wait derives from, for one resolved child-stall
 * setting (`SENPI_RPC_CHILD_STALLED_STOP_MAX_MS`, default 60 s).
 */
export function startupEnvelope(stallMs = DEFAULT_CHILD_STALLED_STOP_MAX_MS) {
	const decision = STARTUP_DECISION_BUDGET_MS;
	const stop =
		Math.max(CHILD_STOP_TIMEOUT_MS, stallMs) + CHILD_KILL_EXIT_TIMEOUT_MS + STOP_REAP_MARGIN_MS + SIGKILL_GRACE_MS;
	const cleanup = stop + FAILED_START_FINALIZE_MS;
	const settled = decision + cleanup;
	const holder = DISCOVERY_BUDGET_MS + stop + settled;
	return {
		decision,
		stop,
		cleanup,
		settled,
		discovery: DISCOVERY_BUDGET_MS,
		holder,
		lockWait: holder + LOCK_WAIT_HEADROOM_MS,
		handoverReply: 2 * holder + HANDOVER_REPLY_MARGIN_MS,
	} as const;
}

/** The ensure lock was not acquired within W: no startup was attempted by this caller, and nothing was signalled. */
export function ensureLockWaitDetail(lockWaitMs: number): string {
	return `RPC host ensure lock wait exceeded ${lockWaitMs}ms; startup not started by this caller`;
}

export function startupTimeoutDetail(outcome: StartupTimeout, cleanup: "completed" | "incomplete"): string {
	return [
		`RPC host startup timed out: phase=${outcome.phase}`,
		`limit=${outcome.limit}`,
		`phase_budget_ms=${outcome.phaseBudgetMs}`,
		`startup_budget_ms=${STARTUP_DECISION_BUDGET_MS}`,
		`elapsed_ms=${outcome.elapsedMs}`,
		`cleanup=${cleanup}`,
	].join("; ");
}
