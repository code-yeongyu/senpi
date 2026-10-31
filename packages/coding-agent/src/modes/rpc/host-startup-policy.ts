/**
 * The startup readiness policy of a spawned RPC host, expressed as one controller per start attempt.
 *
 * RED baseline for senpi#4602: this models the policy `startHost` applies today, one fixed 10 s
 * budget that ignores startup progress. The A-amended phase graph replaces it.
 */

export const STARTUP_DECISION_BUDGET_MS = 10_000;

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

const PHASES: readonly StartupPhase[] = [
	"supervisor_bootstrap",
	"supervisor_setup",
	"host_bootstrap",
	"host_runtime",
	"internal_ready",
	"observer_ready",
	"public_published",
	"presenter_resolved",
	"public_verified",
];

export const STARTUP_PHASE_ALLOWANCE_MS: Readonly<Record<StartupPhase, number>> = Object.fromEntries(
	PHASES.map((phase) => [phase, STARTUP_DECISION_BUDGET_MS]),
) as Record<StartupPhase, number>;

export interface StartupClock {
	now(): number;
	scheduleAt(at: number, fire: () => void): unknown;
	cancel(handle: unknown): void;
}

export type StartupOutcome =
	| { readonly kind: "ready"; readonly elapsedMs: number }
	| {
			readonly kind: "timeout";
			readonly phase: StartupPhase;
			readonly limit: "phase" | "overall";
			readonly phaseBudgetMs: number;
			readonly elapsedMs: number;
	  }
	| { readonly kind: "failed"; readonly phase: StartupPhase; readonly cause: Error; readonly elapsedMs: number };

export interface StartupController {
	complete(phase: StartupPhase): "accepted" | "ignored" | "rejected";
	fail(cause: Error): void;
	readonly terminal: StartupOutcome | undefined;
}

export function startStartupController(options: {
	readonly launchKind: "initial" | "successor";
	readonly clock: StartupClock;
}): StartupController {
	const { clock } = options;
	const t0 = clock.now();
	let index = 0;
	let terminal: StartupOutcome | undefined;
	const settle = (outcome: StartupOutcome) => {
		terminal ??= outcome;
	};
	const timeout = () =>
		settle({
			kind: "timeout",
			phase: PHASES[index]!,
			limit: "overall",
			phaseBudgetMs: STARTUP_DECISION_BUDGET_MS,
			elapsedMs: clock.now() - t0,
		});
	clock.scheduleAt(t0 + STARTUP_DECISION_BUDGET_MS, timeout);
	return {
		complete(phase) {
			if (terminal) return "rejected";
			if (phase !== PHASES[index]) return "rejected";
			index += 1;
			if (index === PHASES.length) settle({ kind: "ready", elapsedMs: clock.now() - t0 });
			return "accepted";
		},
		fail(cause) {
			settle({ kind: "failed", phase: PHASES[index]!, cause, elapsedMs: clock.now() - t0 });
		},
		get terminal() {
			return terminal;
		},
	};
}

export function startupEnvelope(_stallMs = 60_000): Record<string, number> {
	throw new Error("senpi#4602: the A-amended startup envelope is not derived yet");
}

export function startupTimeoutDetail(_outcome: StartupOutcome, _cleanup: "completed" | "incomplete"): string {
	throw new Error("senpi#4602: the A-amended startup timeout detail is not implemented yet");
}
