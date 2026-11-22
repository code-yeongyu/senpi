/**
 * The derived validity oracle of `offload-profile.mjs` (senpi#3566 todo 5): a synthetic report that
 * matches the workload passes, and every way a run can be incomplete fails with its own named reason.
 */
import { describe, expect, test } from "vitest";
import { EXPECTED_HISTOGRAM, evaluateValidity, expectedToolEvents } from "./lib/offload-evaluate.mjs";

const PHASES = ["empty", "opened", "after_turns", "after_big_opens", "after_close"];

function sessionEvents(): { tool: string; isError: boolean }[] {
	const events: { tool: string; isError: boolean }[] = [];
	for (const [tool, count] of Object.entries(EXPECTED_HISTOGRAM)) {
		for (let index = 0; index < count; index++) events.push({ tool, isError: false });
	}
	return events;
}

function validReport(sessions: number) {
	const detail = Array.from({ length: sessions }, (_, n) => ({ n, settled: true, tool_events: sessionEvents() }));
	return {
		sessions,
		sessions_detail: detail,
		tool_events_total: detail.reduce((sum, session) => sum + session.tool_events.length, 0),
		compactions: detail.map(({ n }) => ({ n, success: true })),
		big_opens: [{ file: "big-25mb.jsonl", ok: true }],
		memory: Object.fromEntries(PHASES.map((phase) => [phase, { server_mb: 100, children: [] }])),
		server: { pid: 4242, verified: true },
		probe: { count: 12, p50: 1, p90: 2, p99: 3, max: 4 },
		cpu: { server: { total_samples: 900, top: [] } },
	};
}

function reasons(report: unknown): string[] {
	return evaluateValidity(report).failures.map((failure: { reason: string }) => failure.reason);
}

describe("offload-profile validity oracle", () => {
	test("expected tool events are N x 14 with the workload histogram", () => {
		expect(expectedToolEvents(1)).toBe(14);
		expect(expectedToolEvents(10)).toBe(140);
		expect(EXPECTED_HISTOGRAM).toEqual({ eval: 6, read: 2, todo: 2, write: 2, edit: 2 });
	});

	test("a complete synthetic report with 14 events per session and zero errors passes", () => {
		for (const sessions of [1, 10]) {
			const verdict = evaluateValidity(validReport(sessions));
			expect(verdict.failures).toEqual([]);
			expect(verdict.pass).toBe(true);
		}
	});

	test("13 events fails with tool_count_mismatch", () => {
		const report = validReport(2);
		report.sessions_detail[1]?.tool_events.pop();
		report.tool_events_total -= 1;
		expect(reasons(report)).toContain("tool_count_mismatch");
	});

	test("one isError fails with tool_error", () => {
		const report = validReport(2);
		const event = report.sessions_detail[0]?.tool_events[3];
		if (event) event.isError = true;
		expect(reasons(report)).toEqual(["tool_error"]);
	});

	test("a histogram mismatch with the right count fails with tool_histogram_mismatch", () => {
		const report = validReport(1);
		const event = report.sessions_detail[0]?.tool_events.find((candidate) => candidate.tool === "read");
		if (event) event.tool = "eval";
		expect(reasons(report)).toEqual(["tool_histogram_mismatch"]);
	});

	test("an unsettled session fails with turn_timeout", () => {
		const report = validReport(3);
		const session = report.sessions_detail[2];
		if (session) session.settled = false;
		expect(reasons(report)).toContain("turn_timeout");
	});

	test("a failed compaction fails with compaction_failed and a failed open with big_open_failed", () => {
		const compaction = validReport(2);
		const first = compaction.compactions[0];
		if (first) first.success = false;
		expect(reasons(compaction)).toEqual(["compaction_failed"]);
		const open = validReport(1);
		const big = open.big_opens[0];
		if (big) big.ok = false;
		expect(reasons(open)).toEqual(["big_open_failed"]);
	});

	test("a missing compaction record is a compaction failure, not a pass", () => {
		const report = validReport(2);
		report.compactions.pop();
		expect(reasons(report)).toEqual(["compaction_failed"]);
	});

	test("a null snapshot fails with snapshot_null", () => {
		const report = validReport(1);
		report.memory.after_turns = { server_mb: null, children: [] } as never;
		expect(reasons(report)).toEqual(["snapshot_null"]);
	});

	test("an unverified pid fails with pid_unverified", () => {
		const report = validReport(1);
		report.server.verified = false;
		expect(reasons(report)).toEqual(["pid_unverified"]);
	});

	test("missing measurements fail with measurement_missing instead of passing", () => {
		const noProbe = validReport(1);
		noProbe.probe.count = 0;
		expect(reasons(noProbe)).toEqual(["measurement_missing"]);
		const noProfile = validReport(1) as Record<string, unknown>;
		delete noProfile.cpu;
		expect(reasons(noProfile)).toEqual(["measurement_missing"]);
		const noPhase = validReport(1);
		delete (noPhase.memory as Record<string, unknown>).after_close;
		expect(reasons(noPhase)).toEqual(["snapshot_null"]);
	});

	test("a report that is not an object fails closed", () => {
		expect(evaluateValidity(undefined).pass).toBe(false);
		expect(evaluateValidity({}).pass).toBe(false);
	});
});
