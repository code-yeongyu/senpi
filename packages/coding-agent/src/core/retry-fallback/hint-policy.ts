/**
 * Pure tier-policy and probe-schedule decisions for hint-aware 429 retry.
 * No timers, no I/O — all time values are injected by the caller.
 */

export type HintTier = "no-hint-fast-fallback" | "tier1-in-turn" | "tier2-fallback-probe-back" | "tier3-fallback-only";

export function classifyRateLimitedWait(
	hintMs: number | undefined,
	settings: { hintedWaitCapMs: number; probeBackMaxMs: number },
): HintTier {
	if (hintMs === undefined) return "no-hint-fast-fallback";
	if (hintMs <= settings.hintedWaitCapMs) return "tier1-in-turn";
	if (hintMs < settings.probeBackMaxMs) return "tier2-fallback-probe-back";
	return "tier3-fallback-only";
}

export function probeBackSchedule(hintMs: number, nowMs: number): { firstAtMs: number; deadlineMs: number } {
	return { firstAtMs: nowMs + Math.ceil(hintMs / 2), deadlineMs: nowMs + hintMs };
}

export type ProbePhase = "idle" | "half-used" | "done";

export interface InTurnState {
	probePhase: ProbePhase;
	hintDeadlineMs?: number;
	attempt: number;
	cumulativeHintedWaitMs: number;
}

export interface InTurnResult {
	delayMs: number;
	probePhase: "half-used" | "done";
	hintDeadlineMs?: number;
	cumulativeHintedWaitMs: number;
	demoteToProbeBack: boolean;
}

export function nextInTurnDelayMs(
	state: InTurnState,
	hintMs: number | undefined,
	baseDelayMs: number,
	hintedWaitCapMs: number,
	nowMs: number,
): InTurnResult {
	// Phase: half-used -> consecutive 429 with deadline sleep
	if (state.probePhase === "half-used") {
		const deadlineMs = hintMs !== undefined ? nowMs + hintMs : (state.hintDeadlineMs ?? nowMs);
		const remaining = Math.max(0, deadlineMs - nowMs);
		const newCumulative = state.cumulativeHintedWaitMs + remaining;
		return {
			delayMs: remaining,
			probePhase: "done",
			hintDeadlineMs: deadlineMs,
			cumulativeHintedWaitMs: newCumulative,
			demoteToProbeBack: newCumulative > hintedWaitCapMs,
		};
	}

	// Phase: idle -> first hinted 429, probe at hint/2
	if (state.probePhase === "idle" && hintMs !== undefined) {
		const delay = Math.ceil(hintMs / 2);
		const deadlineMs = nowMs + hintMs;
		const newCumulative = state.cumulativeHintedWaitMs + delay;
		return {
			delayMs: delay,
			probePhase: "half-used",
			hintDeadlineMs: deadlineMs,
			cumulativeHintedWaitMs: newCumulative,
			demoteToProbeBack: newCumulative > hintedWaitCapMs,
		};
	}

	// Phase: done (or idle without hint = non-429 / no-hint fallback) -> exponential or hint override
	const delay = hintMs ?? baseDelayMs * 2 ** (state.attempt - 1);
	return {
		delayMs: delay,
		probePhase: "done",
		hintDeadlineMs: state.hintDeadlineMs,
		cumulativeHintedWaitMs: state.cumulativeHintedWaitMs,
		demoteToProbeBack: false,
	};
}
