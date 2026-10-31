/**
 * `offload-gate.mjs` applies the improvement thresholds to the candidate report only; `--functions`
 * narrows the function-absence row to the functions an earlier todo migrated.
 */
import { describe, expect, test } from "vitest";
import { ABSENT_FUNCTIONS, evaluateGate } from "./lib/offload-gate-rules.mjs";

interface Row {
	function: string;
	samples: number;
	share: number;
}

function topRows(extra: readonly string[] = [], shares: Record<string, number> = {}): Row[] {
	const rows: Row[] = [{ function: "runLoop", samples: 400, share: 40 }];
	for (const name of extra) rows.push({ function: name, samples: 10, share: 1 });
	for (const [name, share] of Object.entries(shares)) rows.push({ function: name, samples: share * 10, share });
	return rows;
}

function passingCandidate(top: Row[] = topRows([], { "JSON.stringify": 4, transformJsonValue: 1 })) {
	return {
		sessions: 10,
		probe: { count: 100, p50: 2, p90: 5, p99: 12, max: 30 },
		big_open_probe_max_ms: 60,
		memory: {
			opened: { server_mb: 200, children: [] },
			after_turns: { server_mb: 400, children: [] },
			after_close: { server_mb: 120, children: [] },
		},
		child_idle_mb: 45,
		cpu: { server: { total_samples: 1000, top } },
	};
}

function failingBaseline() {
	return {
		...passingCandidate(topRows([...ABSENT_FUNCTIONS], { "JSON.stringify": 4, transformJsonValue: 1 })),
		probe: { count: 100, p50: 50, p90: 900, p99: 4000, max: 60000 },
		big_open_probe_max_ms: 20000,
		memory: {
			opened: { server_mb: 200, children: [] },
			after_turns: { server_mb: 2400, children: [] },
			after_close: { server_mb: 900, children: [] },
		},
		child_idle_mb: 300,
	};
}

function failedRows(verdict: { rows: { row: string; pass: boolean }[] }): string[] {
	return verdict.rows.filter((row) => !row.pass).map((row) => row.row);
}

describe("offload gate", () => {
	test("the baseline is never threshold-checked", () => {
		const verdict = evaluateGate({ baseline: failingBaseline(), candidate: passingCandidate() });
		expect(failedRows(verdict)).toEqual([]);
		expect(verdict.pass).toBe(true);
		expect(verdict.rows.every((row: { subject: string }) => row.subject === "candidate")).toBe(true);
		const reversed = evaluateGate({ baseline: passingCandidate(), candidate: failingBaseline() });
		expect(reversed.pass).toBe(false);
	});

	const thresholdCases: { row: string; fail: (report: ReturnType<typeof passingCandidate>) => void }[] = [
		{ row: "probe_p99", fail: (report) => (report.probe.p99 = 21) },
		{ row: "big_open_probe_max", fail: (report) => (report.big_open_probe_max_ms = 100) },
		{ row: "turn_mb_per_session", fail: (report) => (report.memory.after_turns.server_mb = 200 + 10 * 31) },
		{ row: "after_close_mb", fail: (report) => (report.memory.after_close.server_mb = 151) },
		{ row: "child_idle_mb", fail: (report) => (report.child_idle_mb = 61) },
		{
			row: "function_absence",
			fail: (report) => report.cpu.server.top.push({ function: "loadEntriesFromFile", samples: 5, share: 0.5 }),
		},
		{
			row: "build_compaction_context",
			fail: (report) => report.cpu.server.top.push({ function: "buildCompactionContext", samples: 10, share: 1 }),
		},
		{
			row: "serialization",
			fail: (report) => {
				report.cpu.server.top = topRows([], { "JSON.stringify": 7, transformJsonValue: 1 });
			},
		},
	];

	for (const { row, fail } of thresholdCases) {
		test(`${row} has a passing and a failing candidate`, () => {
			const baseline = passingCandidate();
			const passing = evaluateGate({ baseline, candidate: passingCandidate(), only: row });
			expect(passing.rows.map((entry: { row: string }) => entry.row)).toEqual([row]);
			expect(passing.pass).toBe(true);
			const candidate = passingCandidate();
			fail(candidate);
			const failing = evaluateGate({ baseline, candidate, only: row });
			expect(failedRows(failing)).toEqual([row]);
			expect(failing.pass).toBe(false);
		});
	}

	test("a missing candidate measurement fails its row instead of passing", () => {
		const candidate = passingCandidate() as Record<string, unknown>;
		delete candidate.child_idle_mb;
		const verdict = evaluateGate({ baseline: passingCandidate(), candidate, only: "child_idle_mb" });
		expect(verdict.pass).toBe(false);
		expect(verdict.rows[0]?.reason).toBe("measurement_missing");
	});

	test("--functions scopes function absence to the named subset", () => {
		const candidate = passingCandidate(topRows(["spawn"]));
		const scoped = evaluateGate({
			baseline: passingCandidate(),
			candidate,
			only: "function_absence",
			functions: ["enumerateCandidates", "searchSegments"],
		});
		expect(scoped.pass).toBe(true);
		const withSearch = passingCandidate(topRows(["searchSegments"]));
		const scopedFail = evaluateGate({
			baseline: passingCandidate(),
			candidate: withSearch,
			only: "function_absence",
			functions: ["enumerateCandidates", "searchSegments"],
		});
		expect(scopedFail.pass).toBe(false);
		expect(scopedFail.rows[0]?.detail).toContain("searchSegments");
		const unscoped = evaluateGate({ baseline: passingCandidate(), candidate, only: "function_absence" });
		expect(unscoped.pass).toBe(false);
		expect(unscoped.rows[0]?.detail).toContain("spawn");
	});

	test("function absence only looks at the top 50 by sample count", () => {
		const top = topRows(Array.from({ length: 60 }, (_, index) => `filler${index}`));
		top.push({ function: "spawn", samples: 1, share: 0.01 });
		const verdict = evaluateGate({
			baseline: passingCandidate(),
			candidate: passingCandidate(top),
			only: "function_absence",
		});
		expect(verdict.pass).toBe(true);
	});

	test("an unknown --only row is refused", () => {
		expect(() => evaluateGate({ baseline: passingCandidate(), candidate: passingCandidate(), only: "nope" })).toThrow(
			/unknown gate row/,
		);
	});
});
