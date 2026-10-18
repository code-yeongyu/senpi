import type { CompactionReason } from "../../types.ts";
import type { CompactionExtensionState } from "./state.ts";

export const FAILURE_TRIP_THRESHOLD = 3;
export const COOLDOWN_MS = 60_000;

export interface BreakerNotification {
	tripped: true;
	failureCount: number;
	trippedAt: number;
	reason: CompactionReason | "threshold";
}

export interface RecordFailureOptions {
	onTrip?: (notification: BreakerNotification) => void;
	route?: CompactionReason;
}

export interface ShouldBypassOptions {
	manual?: boolean;
	reason?: CompactionReason;
}

export function recordSuccess(state: CompactionExtensionState): CompactionExtensionState {
	return { ...state, consecutiveFailures: 0, trippedAt: null };
}

export function recordFailure(
	state: CompactionExtensionState,
	now: number,
	opts?: RecordFailureOptions,
): CompactionExtensionState {
	let working = state;
	if (working.trippedAt !== null && now >= working.trippedAt + COOLDOWN_MS) {
		working = { ...working, consecutiveFailures: 0, trippedAt: null };
	}
	const next: CompactionExtensionState = {
		...working,
		consecutiveFailures: working.consecutiveFailures + 1,
	};
	if (next.consecutiveFailures >= FAILURE_TRIP_THRESHOLD && next.trippedAt === null) {
		next.trippedAt = now;
		opts?.onTrip?.({
			tripped: true,
			failureCount: next.consecutiveFailures,
			trippedAt: now,
			reason: opts.route ?? "threshold",
		});
	}
	return next;
}

export function isTripped(state: CompactionExtensionState, now: number): boolean {
	return state.trippedAt !== null && now < state.trippedAt + COOLDOWN_MS;
}

/**
 * A tripped breaker halts *automatic* compaction only. An explicit `/compact` is the
 * user's escape hatch - and on an SDK-owned lane it is the documented recovery from a
 * rejected model downswitch - so refusing it during the cooldown would strand the very
 * session the recovery exists for. Manual failures are still recorded (see the
 * `ownsCompaction` failure-accounting site in `index.ts`), so they count toward the
 * trip that protects the automatic routes.
 */
export function shouldBypass(_state: CompactionExtensionState, opts?: ShouldBypassOptions): boolean {
	if (opts?.manual === true) return true;
	if (opts?.reason === "manual") return true;
	return false;
}
