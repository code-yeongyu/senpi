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
	| "opaque_host"
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
	// A custom host-child command that cannot report progress: one phase from its spawn, completed only by
	// the authenticated internal reply, replacing host_bootstrap + host_runtime.
	opaque_host: 90_000,
	internal_ready: 15_000,
	observer_ready: 15_000,
	public_published: 15_000,
	presenter_resolved: 30_000,
	public_verified: 10_000,
};

/**
 * `legacy`: a supervisor command that is not known to report progress. It gets one public-ready phase of the
 * whole decision budget from spawn, with no renewals, and keeps every inner limit of its own.
 */
export type StartupLaunchKind = "initial" | "successor" | "legacy";

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
	legacy: ["public_verified"],
};

const OPAQUE_REPLACES: readonly StartupPhase[] = ["host_bootstrap", "host_runtime", "internal_ready"];

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
	/**
	 * The supervisor declares, before it spawns its host child, that the child cannot report progress. Only
	 * an initial launch in supervisor_setup may switch; the opaque phase then replaces the child's phases.
	 */
	declareOpaqueHost(): "accepted" | "rejected";
	fail(cause: Error): void;
	readonly terminal: StartupOutcome | undefined;
	readonly phase: StartupPhase;
	/** Milliseconds left before the current phase's deadline; 0 once terminal. */
	remainingMs(): number;
	/** Resolves true once `phase` is the current phase, false once the attempt is terminal first. */
	whenPhase(phase: StartupPhase): Promise<boolean>;
	/** Resolves with the terminal outcome. */
	settled(): Promise<StartupOutcome>;
}

/** Create the controller immediately BEFORE spawning: its creation instant is the spawn origin. */
export function startStartupController(options: {
	readonly launchKind: StartupLaunchKind;
	readonly clock: StartupClock;
	/** G for this attempt; only tests lower it. */
	readonly decisionBudgetMs?: number;
}): StartupController {
	const { clock } = options;
	const budget = options.decisionBudgetMs ?? STARTUP_DECISION_BUDGET_MS;
	let path = PHASE_PATH[options.launchKind];
	const t0 = clock.now();
	const ceiling = t0 + budget;
	let index = 0;
	let phaseLimit = 0;
	let deadline = 0;
	let timer: unknown;
	let terminal: StartupOutcome | undefined;
	const listeners = new Set<() => void>();

	const current = (): StartupPhase => path[Math.min(index, path.length - 1)] ?? "supervisor_bootstrap";
	const allowance = (phase: StartupPhase): number =>
		options.launchKind === "legacy" ? budget : STARTUP_PHASE_ALLOWANCE_MS[phase];
	const notify = (): void => {
		for (const listener of [...listeners]) listener();
	};
	const settle = (outcome: StartupOutcome): void => {
		if (terminal) return;
		terminal = outcome;
		clock.cancel(timer);
		notify();
	};
	const expire = (): void => {
		const phase = current();
		settle({
			kind: "timeout",
			phase,
			limit: phaseLimit < ceiling ? "phase" : "overall",
			phaseBudgetMs: allowance(phase),
			elapsedMs: deadline - t0,
		});
	};
	const enter = (at: number): void => {
		phaseLimit = at + allowance(current());
		deadline = Math.min(phaseLimit, ceiling);
		timer = clock.scheduleAt(deadline, expire);
		notify();
	};
	/** Ingress sampling: at or past the deadline, expiry wins over whatever just arrived. */
	const expiredAt = (now: number): boolean => {
		if (!terminal && now >= deadline) expire();
		return terminal !== undefined;
	};

	const waitFor = <T>(check: () => T | undefined): Promise<T> => {
		const ready = check();
		if (ready !== undefined) return Promise.resolve(ready);
		return new Promise<T>((resolveWait) => {
			const listener = (): void => {
				const value = check();
				if (value === undefined) return;
				listeners.delete(listener);
				resolveWait(value);
			};
			listeners.add(listener);
		});
	};

	enter(t0);
	return {
		complete(requested) {
			const now = clock.now();
			if (expiredAt(now)) return "rejected";
			// In the opaque path the supervisor's authenticated internal reply is what completes opaque_host.
			const phase = requested === "internal_ready" && current() === "opaque_host" ? "opaque_host" : requested;
			const position = path.indexOf(phase);
			if (position >= 0 && position < index) return "ignored";
			if (position !== index) return "rejected";
			clock.cancel(timer);
			index += 1;
			if (index === path.length) settle({ kind: "ready", elapsedMs: now - t0 });
			else enter(now);
			return "accepted";
		},
		declareOpaqueHost() {
			if (expiredAt(clock.now())) return "rejected";
			if (options.launchKind !== "initial" || current() !== "supervisor_setup") return "rejected";
			const [before = [], after = []] = [path.slice(0, index + 1), path.slice(index + 1)];
			path = [...before, "opaque_host", ...after.filter((phase) => !OPAQUE_REPLACES.includes(phase))];
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
		get phase() {
			return current();
		},
		remainingMs() {
			return terminal ? 0 : Math.max(0, deadline - clock.now());
		},
		whenPhase(phase) {
			return waitFor(() => (terminal ? false : current() === phase ? true : undefined));
		},
		settled() {
			return waitFor(() => terminal);
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
