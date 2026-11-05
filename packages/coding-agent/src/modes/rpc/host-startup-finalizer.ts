/**
 * The one terminal finalizer of a startup attempt (senpi#4602, A-amended section 6). Every failure path
 * (timeout, explicit failure, protocol fault, registration error) settles through it exactly once: it
 * latches the original cause, runs the owned cleanup inside its nonrenewable allowance, and reports
 * `cleanup=incomplete` when that cleanup did not finish in time or failed. The original diagnostic
 * always comes first; a cleanup failure is appended after it, never instead of it.
 */
import { childStalledStopMaxMs } from "./host-stalled-evidence.ts";
import type { StartupClock, StartupOutcome } from "./host-startup-policy.ts";
import { startupEnvelope, startupTimeoutDetail } from "./host-startup-policy.ts";
import { monotonicStartupClock } from "./host-startup-run.ts";

export type StartupFailure = Exclude<StartupOutcome, { readonly kind: "ready" }>;

export interface StartupFinalReport {
	readonly outcome: StartupFailure;
	readonly cleanup: "completed" | "incomplete";
	readonly detail: string;
}

export function createStartupFinalizer(options: {
	readonly clock: StartupClock;
	/** C: the failed-start cleanup allowance; startup progress never renews it. */
	readonly cleanupBudgetMs: number;
	/** Owned teardown of this attempt's own resources; it must leave live evidence in place when it cannot prove death. */
	readonly cleanup: () => Promise<void>;
}): (outcome: StartupFailure) => Promise<StartupFinalReport> {
	let settled: Promise<StartupFinalReport> | undefined;
	return (outcome) => {
		settled ??= finalize(outcome);
		return settled;
	};

	async function finalize(outcome: StartupFailure): Promise<StartupFinalReport> {
		const { clock } = options;
		let timer: unknown;
		const expired = new Promise<"expired">((resolveExpired) => {
			timer = clock.scheduleAt(clock.now() + options.cleanupBudgetMs, () => resolveExpired("expired"));
		});
		const ran = options.cleanup().then(
			() => "completed" as const,
			(error: unknown) => (error instanceof Error ? error : new Error(String(error))),
		);
		const result = await Promise.race([ran, expired]);
		clock.cancel(timer);
		const cleanup = result === "completed" ? "completed" : "incomplete";
		const original = outcome.kind === "timeout" ? startupTimeoutDetail(outcome, cleanup) : outcome.cause.message;
		const appended =
			result instanceof Error
				? `\ncleanup failed: ${result.message}`
				: result === "expired"
					? `\ncleanup did not finish within ${options.cleanupBudgetMs}ms`
					: "";
		return { outcome, cleanup, detail: `${original}${appended}` };
	}
}

/** One failed `startHost` attempt, settled once: owned cleanup inside the failed-start allowance C at the resolved stall setting. */
export function finalizeFailedStart(
	outcome: StartupFailure,
	cleanup: () => Promise<void>,
): Promise<StartupFinalReport> {
	return createStartupFinalizer({
		clock: monotonicStartupClock(),
		cleanupBudgetMs: startupEnvelope(childStalledStopMaxMs()).cleanup,
		cleanup,
	})(outcome);
}
