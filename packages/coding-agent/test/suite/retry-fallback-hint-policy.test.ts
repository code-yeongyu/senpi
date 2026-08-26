import { describe, expect, it } from "vitest";
import {
	classifyRateLimitedWait,
	degradeWithoutFallback,
	nextInTurnDelayMs,
	probeBackSchedule,
} from "../../src/core/retry-fallback/hint-policy.ts";

const CAP = 300_000;
const PROBE_MAX = 3_600_000;
const SETTINGS = { hintedWaitCapMs: CAP, probeBackMaxMs: PROBE_MAX };
const BASE = 2_000;

// ---------------------------------------------------------------------------
// classifyRateLimitedWait
// ---------------------------------------------------------------------------

describe("classifyRateLimitedWait", () => {
	it("returns no-hint-fast-fallback for undefined hint", () => {
		expect(classifyRateLimitedWait(undefined, SETTINGS)).toBe("no-hint-fast-fallback");
	});

	it("returns tier1-in-turn for zero hint (explicit retry-now)", () => {
		expect(classifyRateLimitedWait(0, SETTINGS)).toBe("tier1-in-turn");
	});

	it("returns tier1-in-turn just below the cap", () => {
		expect(classifyRateLimitedWait(299_999, SETTINGS)).toBe("tier1-in-turn");
	});

	it("returns tier1-in-turn at the cap boundary (300_000)", () => {
		expect(classifyRateLimitedWait(300_000, SETTINGS)).toBe("tier1-in-turn");
	});

	it("returns tier2-fallback-probe-back just above the cap", () => {
		expect(classifyRateLimitedWait(300_001, SETTINGS)).toBe("tier2-fallback-probe-back");
	});

	it("returns tier2-fallback-probe-back just below probeBackMax", () => {
		expect(classifyRateLimitedWait(3_599_999, SETTINGS)).toBe("tier2-fallback-probe-back");
	});

	it("returns tier3-fallback-only at the probeBackMax boundary (3_600_000)", () => {
		expect(classifyRateLimitedWait(3_600_000, SETTINGS)).toBe("tier3-fallback-only");
	});

	it("returns tier3-fallback-only above the probeBackMax", () => {
		expect(classifyRateLimitedWait(7_200_000, SETTINGS)).toBe("tier3-fallback-only");
	});

	it("honours custom settings boundaries", () => {
		const s = { hintedWaitCapMs: 10_000, probeBackMaxMs: 60_000 };
		expect(classifyRateLimitedWait(10_000, s)).toBe("tier1-in-turn");
		expect(classifyRateLimitedWait(10_001, s)).toBe("tier2-fallback-probe-back");
		expect(classifyRateLimitedWait(59_999, s)).toBe("tier2-fallback-probe-back");
		expect(classifyRateLimitedWait(60_000, s)).toBe("tier3-fallback-only");
	});
});

// ---------------------------------------------------------------------------
// probeBackSchedule
// ---------------------------------------------------------------------------

describe("probeBackSchedule", () => {
	it("schedules first probe at ceil(hint/2) and deadline at now+hint", () => {
		expect(probeBackSchedule(10_000, 1_000)).toEqual({ firstAtMs: 6_000, deadlineMs: 11_000 });
	});

	it("rounds up odd hint to next integer for first probe", () => {
		expect(probeBackSchedule(7_001, 0)).toEqual({ firstAtMs: 3_501, deadlineMs: 7_001 });
	});

	it("handles zero hint (both probes at now)", () => {
		expect(probeBackSchedule(0, 5_000)).toEqual({ firstAtMs: 5_000, deadlineMs: 5_000 });
	});

	it("handles large hint", () => {
		expect(probeBackSchedule(3_600_000, 0)).toEqual({ firstAtMs: 1_800_000, deadlineMs: 3_600_000 });
	});
});

// ---------------------------------------------------------------------------
// nextInTurnDelayMs — transition table
// ---------------------------------------------------------------------------

describe("nextInTurnDelayMs", () => {
	// --- first hinted 429 (idle -> half-used) ---

	it("first hinted 429: probePhase half-used, delay = ceil(hint/2), deadline = now+hint", () => {
		const result = nextInTurnDelayMs(
			{ probePhase: "idle", attempt: 1, cumulativeHintedWaitMs: 0 },
			120_000,
			BASE,
			CAP,
			1_000,
		);
		expect(result).toEqual({
			delayMs: 60_000,
			probePhase: "half-used",
			hintDeadlineMs: 121_000,
			cumulativeHintedWaitMs: 60_000,
			demoteToProbeBack: false,
		});
	});

	it("first hinted 429 with odd hint: ceil rounds up", () => {
		const result = nextInTurnDelayMs(
			{ probePhase: "idle", attempt: 1, cumulativeHintedWaitMs: 0 },
			7_001,
			BASE,
			CAP,
			0,
		);
		expect(result.delayMs).toBe(3_501);
		expect(result.probePhase).toBe("half-used");
		expect(result.hintDeadlineMs).toBe(7_001);
	});

	it("first hinted 429 with explicit zero: still waits the exponential floor, half-used", () => {
		// A retry-now hint may not bypass same-model backoff pressure (#1005): the
		// floor keeps repeated short hints from hammering an already rate-limited model.
		const result = nextInTurnDelayMs(
			{ probePhase: "idle", attempt: 1, cumulativeHintedWaitMs: 0 },
			0,
			BASE,
			CAP,
			5_000,
		);
		expect(result.delayMs).toBe(BASE); // floor 2000 * 2^0
		expect(result.probePhase).toBe("half-used");
		expect(result.hintDeadlineMs).toBe(5_000);
		expect(result.cumulativeHintedWaitMs).toBe(BASE);
		expect(result.demoteToProbeBack).toBe(false);
	});

	it("first hinted 429 with a short hint: exponential floor wins over half-hint", () => {
		const result = nextInTurnDelayMs(
			{ probePhase: "idle", attempt: 1, cumulativeHintedWaitMs: 0 },
			3_000,
			BASE,
			CAP,
			0,
		);
		// ceil(3000/2) = 1500 < floor 2000 -> floored to 2000
		expect(result.delayMs).toBe(2_000);
		expect(result.probePhase).toBe("half-used");
		expect(result.hintDeadlineMs).toBe(3_000);
		// cumulative tracks the delay actually slept, not the un-floored half-hint
		expect(result.cumulativeHintedWaitMs).toBe(2_000);
	});

	it("long provider hints still beat the exponential floor", () => {
		const result = nextInTurnDelayMs(
			{ probePhase: "done", attempt: 3, cumulativeHintedWaitMs: 0 },
			30_000,
			BASE,
			CAP,
			0,
		);
		// hint 30000 > floor 2000 * 2^2 = 8000
		expect(result.delayMs).toBe(30_000);
	});

	// --- consecutive 429 after half-used (deadline sleep) ---

	it("consecutive unhinted 429 after half: elapsed deadline still waits the exponential floor", () => {
		const result = nextInTurnDelayMs(
			{ probePhase: "half-used", hintDeadlineMs: 61_000, attempt: 2, cumulativeHintedWaitMs: 60_000 },
			undefined,
			BASE,
			CAP,
			61_000,
		);
		// no new hint -> keep deadline 61000; remaining = 0, floored to 2000 * 2^1 = 4000
		expect(result.delayMs).toBe(4_000);
		expect(result.probePhase).toBe("done");
		expect(result.hintDeadlineMs).toBe(61_000);
		expect(result.cumulativeHintedWaitMs).toBe(64_000);
		expect(result.demoteToProbeBack).toBe(false);
	});

	it("consecutive unhinted 429 after half with time remaining: sleep to prior deadline", () => {
		const result = nextInTurnDelayMs(
			{ probePhase: "half-used", hintDeadlineMs: 100_000, attempt: 2, cumulativeHintedWaitMs: 50_000 },
			undefined,
			BASE,
			CAP,
			30_000,
		);
		// no new hint -> keep deadline 100000; remaining = max(0, 100000 - 30000) = 70000
		expect(result.delayMs).toBe(70_000);
		expect(result.probePhase).toBe("done");
		expect(result.hintDeadlineMs).toBe(100_000);
		expect(result.cumulativeHintedWaitMs).toBe(120_000);
		expect(result.demoteToProbeBack).toBe(false);
	});

	it("consecutive hinted 429 after half: new hint supersedes deadline", () => {
		const result = nextInTurnDelayMs(
			{ probePhase: "half-used", hintDeadlineMs: 100_000, attempt: 2, cumulativeHintedWaitMs: 50_000 },
			80_000,
			BASE,
			CAP,
			30_000,
		);
		// new deadline = 30000 + 80000 = 110000; remaining = 110000 - 30000 = 80000
		expect(result.delayMs).toBe(80_000);
		expect(result.probePhase).toBe("done");
		expect(result.hintDeadlineMs).toBe(110_000);
		expect(result.cumulativeHintedWaitMs).toBe(130_000);
		expect(result.demoteToProbeBack).toBe(false);
	});

	// --- growing hint after half (deadline moves later) ---

	it("growing hint after half: new deadline supersedes old", () => {
		const result = nextInTurnDelayMs(
			{ probePhase: "half-used", hintDeadlineMs: 100_000, attempt: 2, cumulativeHintedWaitMs: 50_000 },
			200_000,
			BASE,
			CAP,
			50_000,
		);
		// new deadline = 50000 + 200000 = 250000; remaining = 250000 - 50000 = 200000
		expect(result.delayMs).toBe(200_000);
		expect(result.probePhase).toBe("done");
		expect(result.hintDeadlineMs).toBe(250_000);
		expect(result.cumulativeHintedWaitMs).toBe(250_000);
	});

	// --- shrinking hint after half (deadline moves earlier) ---

	it("shrinking hint after half: new earlier deadline supersedes", () => {
		const result = nextInTurnDelayMs(
			{ probePhase: "half-used", hintDeadlineMs: 500_000, attempt: 2, cumulativeHintedWaitMs: 250_000 },
			100_000,
			BASE,
			CAP,
			250_000,
		);
		// new deadline = 250000 + 100000 = 350000; remaining = max(0, 350000 - 250000) = 100000
		expect(result.delayMs).toBe(100_000);
		expect(result.probePhase).toBe("done");
		expect(result.hintDeadlineMs).toBe(350_000);
		expect(result.cumulativeHintedWaitMs).toBe(350_000);
	});

	it("shrinking hint with new deadline already in the past: clamped to 0", () => {
		const result = nextInTurnDelayMs(
			{ probePhase: "half-used", hintDeadlineMs: 500_000, attempt: 2, cumulativeHintedWaitMs: 300_000 },
			10_000,
			BASE,
			CAP,
			320_000,
		);
		// new deadline = 320000 + 10000 = 330000; remaining = max(0, 330000 - 320000) = 10000
		expect(result.delayMs).toBe(10_000);
		expect(result.probePhase).toBe("done");
		expect(result.hintDeadlineMs).toBe(330_000);
	});

	// --- explicit zero after half ---

	it("explicit zero after half: exponential floor applies, done", () => {
		const result = nextInTurnDelayMs(
			{ probePhase: "half-used", hintDeadlineMs: 100_000, attempt: 2, cumulativeHintedWaitMs: 50_000 },
			0,
			BASE,
			CAP,
			60_000,
		);
		// new deadline = 60000 + 0 = 60000; remaining = 0, floored to 2000 * 2^1 = 4000
		expect(result.delayMs).toBe(4_000);
		expect(result.probePhase).toBe("done");
		expect(result.hintDeadlineMs).toBe(60_000);
		expect(result.cumulativeHintedWaitMs).toBe(54_000);
		expect(result.demoteToProbeBack).toBe(false);
	});

	// --- unhinted 429 after half (keeps prior deadline) ---

	it("unhinted 429 after half: keeps prior deadline, sleeps remaining", () => {
		const result = nextInTurnDelayMs(
			{ probePhase: "half-used", hintDeadlineMs: 100_000, attempt: 2, cumulativeHintedWaitMs: 50_000 },
			undefined,
			BASE,
			CAP,
			60_000,
		);
		// no new hint -> keep deadline 100000; remaining = max(0, 100000 - 60000) = 40000
		expect(result.delayMs).toBe(40_000);
		expect(result.probePhase).toBe("done");
		expect(result.hintDeadlineMs).toBe(100_000);
		expect(result.cumulativeHintedWaitMs).toBe(90_000);
		expect(result.demoteToProbeBack).toBe(false);
	});

	// --- non-429 after half (probePhase done -> exponential) ---

	it("non-429 after half (probePhase done, no hint): exponential backoff", () => {
		const result = nextInTurnDelayMs(
			{ probePhase: "done", hintDeadlineMs: 100_000, attempt: 3, cumulativeHintedWaitMs: 50_000 },
			undefined,
			BASE,
			CAP,
			60_000,
		);
		// 2000 * 2^(3-1) = 8000
		expect(result.delayMs).toBe(8_000);
		expect(result.probePhase).toBe("done");
		expect(result.demoteToProbeBack).toBe(false);
	});

	// --- after done: exponential with hint override ---

	it("after done with a short fresh hint: exponential floor overrides the hint", () => {
		const result = nextInTurnDelayMs(
			{ probePhase: "done", attempt: 3, cumulativeHintedWaitMs: 120_000 },
			5_000,
			BASE,
			CAP,
			200_000,
		);
		// hint 5000 < floor 2000 * 2^2 = 8000
		expect(result.delayMs).toBe(8_000);
		expect(result.probePhase).toBe("done");
		expect(result.demoteToProbeBack).toBe(false);
	});

	it("after done without hint: exponential 2^(attempt-1)", () => {
		const r2 = nextInTurnDelayMs(
			{ probePhase: "done", attempt: 2, cumulativeHintedWaitMs: 120_000 },
			undefined,
			BASE,
			CAP,
			200_000,
		);
		expect(r2.delayMs).toBe(4_000); // 2000 * 2^1
	});

	it("after done without hint: attempt 4 exponential", () => {
		const r4 = nextInTurnDelayMs(
			{ probePhase: "done", attempt: 4, cumulativeHintedWaitMs: 120_000 },
			undefined,
			BASE,
			CAP,
			200_000,
		);
		expect(r4.delayMs).toBe(16_000); // 2000 * 2^3
	});

	it("exponent never restarts: done at attempt 3 then 4", () => {
		const r3 = nextInTurnDelayMs(
			{ probePhase: "done", attempt: 3, cumulativeHintedWaitMs: 100_000 },
			undefined,
			BASE,
			CAP,
			200_000,
		);
		expect(r3.delayMs).toBe(8_000); // 2000 * 2^2

		const r4 = nextInTurnDelayMs(
			{ probePhase: "done", attempt: 4, cumulativeHintedWaitMs: 100_000 },
			undefined,
			BASE,
			CAP,
			200_000,
		);
		expect(r4.delayMs).toBe(16_000); // 2000 * 2^3
	});

	// --- demotion at cumulative cap ---

	it("demotes to probe-back when cumulative + delay exceeds cap", () => {
		const result = nextInTurnDelayMs(
			{ probePhase: "idle", attempt: 1, cumulativeHintedWaitMs: 290_000 },
			120_000,
			BASE,
			CAP,
			1_000,
		);
		// delay = ceil(120000/2) = 60000; cumulative = 290000 + 60000 = 350000 > 300000
		expect(result.delayMs).toBe(60_000);
		expect(result.cumulativeHintedWaitMs).toBe(350_000);
		expect(result.demoteToProbeBack).toBe(true);
	});

	it("does NOT demote when cumulative + delay equals cap exactly", () => {
		const result = nextInTurnDelayMs(
			{ probePhase: "idle", attempt: 1, cumulativeHintedWaitMs: 240_000 },
			120_000,
			BASE,
			CAP,
			1_000,
		);
		// delay = 60000; cumulative = 240000 + 60000 = 300000 = cap (not >)
		expect(result.delayMs).toBe(60_000);
		expect(result.cumulativeHintedWaitMs).toBe(300_000);
		expect(result.demoteToProbeBack).toBe(false);
	});

	it("demotes on unhinted deadline sleep that pushes cumulative over cap", () => {
		const result = nextInTurnDelayMs(
			{ probePhase: "half-used", hintDeadlineMs: 100_000, attempt: 2, cumulativeHintedWaitMs: 250_001 },
			undefined,
			BASE,
			CAP,
			50_000,
		);
		// keep deadline 100000; remaining = max(0, 100000 - 50000) = 50000; cumulative = 250001 + 50000 = 300001 > 300000
		expect(result.delayMs).toBe(50_000);
		expect(result.demoteToProbeBack).toBe(true);
	});

	it("does not demote on exponential (non-hinted) path even over cap", () => {
		const result = nextInTurnDelayMs(
			{ probePhase: "done", attempt: 5, cumulativeHintedWaitMs: 299_000 },
			undefined,
			BASE,
			CAP,
			500_000,
		);
		// 2000 * 2^4 = 32000; exponential path, no demotion
		expect(result.delayMs).toBe(32_000);
		expect(result.demoteToProbeBack).toBe(false);
	});

	// --- boundary hints ---

	it("boundary: hint exactly at cap (300_000), first probe at half", () => {
		const result = nextInTurnDelayMs(
			{ probePhase: "idle", attempt: 1, cumulativeHintedWaitMs: 0 },
			300_000,
			BASE,
			CAP,
			0,
		);
		expect(result.delayMs).toBe(150_000);
		expect(result.probePhase).toBe("half-used");
		expect(result.hintDeadlineMs).toBe(300_000);
		expect(result.demoteToProbeBack).toBe(false);
	});

	it("boundary: hint at cap, second unhinted probe, cumulative exactly at cap -> no demote", () => {
		const result = nextInTurnDelayMs(
			{ probePhase: "half-used", hintDeadlineMs: 300_000, attempt: 2, cumulativeHintedWaitMs: 150_000 },
			undefined,
			BASE,
			CAP,
			150_000,
		);
		// keep deadline 300000; remaining = max(0, 300000 - 150000) = 150000; cumulative = 150000 + 150000 = 300000 = cap
		expect(result.delayMs).toBe(150_000);
		expect(result.cumulativeHintedWaitMs).toBe(300_000);
		expect(result.demoteToProbeBack).toBe(false);
	});

	it("boundary: hint at cap, second unhinted probe, cumulative over cap -> demote", () => {
		const result = nextInTurnDelayMs(
			{ probePhase: "half-used", hintDeadlineMs: 300_000, attempt: 2, cumulativeHintedWaitMs: 150_001 },
			undefined,
			BASE,
			CAP,
			150_000,
		);
		// remaining = 150000; cumulative = 150001 + 150000 = 300001 > 300000
		expect(result.delayMs).toBe(150_000);
		expect(result.cumulativeHintedWaitMs).toBe(300_001);
		expect(result.demoteToProbeBack).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// nextInTurnDelayMs — exponential floor on same-model 429 waits (#1005)
// ---------------------------------------------------------------------------

describe("nextInTurnDelayMs exponential floor (#1005)", () => {
	it("grows the same-model wait monotonically under repeated short hints", () => {
		// attempt 1: 3s hint -> half-probe 1500 floored to 2000
		const first = nextInTurnDelayMs(
			{ probePhase: "idle", attempt: 1, cumulativeHintedWaitMs: 0 },
			3_000,
			BASE,
			CAP,
			0,
		);
		expect(first.delayMs).toBe(2_000);
		expect(first.cumulativeHintedWaitMs).toBe(2_000);

		// attempt 2: deadline already elapsed -> floored to at least 4000
		const second = nextInTurnDelayMs(
			{
				probePhase: first.probePhase,
				hintDeadlineMs: first.hintDeadlineMs,
				attempt: 2,
				cumulativeHintedWaitMs: first.cumulativeHintedWaitMs,
			},
			undefined,
			BASE,
			CAP,
			10_000,
		);
		expect(second.delayMs).toBeGreaterThanOrEqual(4_000);
		expect(second.cumulativeHintedWaitMs).toBe(first.cumulativeHintedWaitMs + second.delayMs);

		// attempt 3: another short 5s hint cannot undo the accumulated pressure
		const third = nextInTurnDelayMs(
			{ probePhase: "done", attempt: 3, cumulativeHintedWaitMs: second.cumulativeHintedWaitMs },
			5_000,
			BASE,
			CAP,
			20_000,
		);
		expect(third.delayMs).toBe(8_000);
		expect(third.delayMs).toBeGreaterThan(second.delayMs);
	});

	it("leaves a long provider delay untouched when the floor is smaller", () => {
		const result = nextInTurnDelayMs(
			{ probePhase: "done", attempt: 3, cumulativeHintedWaitMs: 0 },
			30_000,
			BASE,
			CAP,
			0,
		);
		expect(result.delayMs).toBe(30_000); // floor 8000 loses
	});

	it("demotion accounting uses the floored delay, not the raw hint", () => {
		const result = nextInTurnDelayMs(
			{ probePhase: "half-used", hintDeadlineMs: 10_000, attempt: 8, cumulativeHintedWaitMs: 40_000 },
			undefined,
			BASE,
			100_000,
			10_000,
		);
		// remaining = 0, floored to 2000 * 2^7 = 256000; cumulative 296000 > 100000 cap
		expect(result.delayMs).toBe(256_000);
		expect(result.cumulativeHintedWaitMs).toBe(296_000);
		expect(result.demoteToProbeBack).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// degradeWithoutFallback
// ---------------------------------------------------------------------------

describe("degradeWithoutFallback", () => {
	it("returns exponential in-turn delays for a no-hint 429", () => {
		expect(degradeWithoutFallback("no-hint-fast-fallback", undefined, 1, BASE, CAP)).toEqual({
			kind: "in-turn",
			delayMs: BASE,
		});
		expect(degradeWithoutFallback("no-hint-fast-fallback", undefined, 3, BASE, CAP)).toEqual({
			kind: "in-turn",
			delayMs: BASE * 4,
		});
	});

	it("clamps tier2 hinted waits to the in-turn cap", () => {
		expect(degradeWithoutFallback("tier2-fallback-probe-back", CAP + 60_000, 1, BASE, CAP)).toEqual({
			kind: "in-turn",
			delayMs: CAP,
		});
	});

	it("floors tier2 hinted waits with the exponential schedule", () => {
		// A tiny cap could otherwise let a degraded tier2 retry hammer the model (#1005).
		expect(degradeWithoutFallback("tier2-fallback-probe-back", 5_000, 4, BASE, 5_000)).toEqual({
			kind: "in-turn",
			delayMs: BASE * 8, // 16_000 floor beats the 5_000 clamp
		});
	});

	it("stays terminal for tier3 waits and reports the hint", () => {
		expect(degradeWithoutFallback("tier3-fallback-only", PROBE_MAX, 1, BASE, CAP)).toEqual({
			kind: "fail",
			hintMs: PROBE_MAX,
		});
	});
});
