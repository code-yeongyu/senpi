/**
 * Absolute head budgets for rows whose base-ratio gate cannot be met by design. A row listed here is judged on
 * the head alone: every head repetition must do the complete work, and the head's median wall time must stay
 * under a ceiling. Pure: no I/O, no clocks.
 *
 * crash-queue-100 on rb and jl: the base (before the queued-cell recovery work) never recovered from the crash.
 * Every queued cell failed (queuedFailed 100, 0 replacements) in about 20 ms, so head/base compares a failure
 * path with the real work. The ceilings are twice the head medians of a calm 2026-10-09 run on an Apple M5 Max
 * laptop on AC (wall: rb 410 ms, jl 1332 ms; cpu: rb 173 ms, jl 937 ms), so a regression in the recovery path still
 * fails. They are absolute, so a much slower host can trip them on a correct head: rerun on a calm host first.
 */

import { median } from "./bench-stats.ts";

export type Observation = string | number | boolean | null;

export interface BudgetRep {
	readonly cpuMs: number;
	readonly wallMs: number;
	readonly observations?: Readonly<Record<string, Observation>>;
}

export interface HeadBudget {
	readonly scenario: string;
	readonly runtimeId: string;
	readonly maxMedianWallMs: number;
	readonly maxMedianCpuMs: number;
	/** Observations every head repetition must report exactly. */
	readonly expect: Readonly<Record<string, Observation>>;
	readonly reason: string;
}

const CRASH_RECOVERY = { queuedOk: 100, queuedFailed: 0, idsExecuted: 100, maxExecutionsPerId: 1, replacements: 1 };
const CRASH_REASON =
	"the base never recovered from the crash (queuedFailed 100, 0 replacements, ~20 ms), so the head/base ratio compares a failure path with the real work";

export const HEAD_BUDGETS: readonly HeadBudget[] = [
	{ scenario: "crash-queue-100", runtimeId: "rb", maxMedianWallMs: 820, maxMedianCpuMs: 350, expect: CRASH_RECOVERY, reason: CRASH_REASON },
	{ scenario: "crash-queue-100", runtimeId: "jl", maxMedianWallMs: 2_700, maxMedianCpuMs: 1_900, expect: CRASH_RECOVERY, reason: CRASH_REASON },
];

export function headBudgetFor(
	scenario: string,
	runtimeId: string,
	budgets: readonly HeadBudget[] = HEAD_BUDGETS,
): HeadBudget | undefined {
	return budgets.find((budget) => budget.scenario === scenario && budget.runtimeId === runtimeId);
}

/** A p95 row (none of today's budget scenarios records one) is checked on its observations only. */
export type BudgetMetric = "cpu" | "wall" | "p95";

/** The reasons a head series misses its budget on one metric row; empty when it meets it. */
export function headBudgetViolations(budget: HeadBudget, head: readonly BudgetRep[], metric: BudgetMetric): string[] {
	if (head.length === 0) return ["no head repetitions were measured"];
	const violations: string[] = [];
	head.forEach((rep, index) => {
		for (const [key, expected] of Object.entries(budget.expect)) {
			const actual = rep.observations?.[key];
			if (actual !== expected) violations.push(`rep ${index + 1}: ${key} ${String(actual)} (expected ${String(expected)})`);
		}
	});
	if (metric === "wall") {
		const wall = median(head.map((rep) => rep.wallMs));
		if (!(wall <= budget.maxMedianWallMs))
			violations.push(`median wall ${wall.toFixed(1)} ms > ceiling ${budget.maxMedianWallMs} ms`);
	}
	if (metric === "cpu") {
		const cpu = median(head.map((rep) => rep.cpuMs));
		if (!(cpu <= budget.maxMedianCpuMs))
			violations.push(`median cpu ${cpu.toFixed(1)} ms > ceiling ${budget.maxMedianCpuMs} ms`);
	}
	return violations;
}
