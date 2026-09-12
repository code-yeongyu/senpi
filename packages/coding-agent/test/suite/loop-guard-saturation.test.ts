import { describe, expect, it } from "vitest";
import type { LoopGuardDetection } from "../../src/core/extensions/builtin/loop-guard/detectors.ts";
import { detectLoop, NoticeGate } from "../../src/core/extensions/builtin/loop-guard/detectors.ts";
import { TRACK_WINDOW } from "../../src/core/extensions/builtin/loop-guard/policy.ts";
import { ToolCallTracker } from "../../src/core/extensions/builtin/loop-guard/tracker.ts";

function collectDetections(calls: readonly (readonly [string, unknown])[]): LoopGuardDetection[] {
	const tracker = new ToolCallTracker();
	const gate = new NoticeGate();
	const detections: LoopGuardDetection[] = [];
	for (const [toolName, args] of calls) {
		tracker.record(toolName, args);
		const detection = detectLoop(tracker.records, gate);
		if (detection !== undefined) detections.push(detection);
	}
	return detections;
}

describe("NoticeGate saturation", () => {
	it("emits one final identical notice when the tracker window saturates", () => {
		const calls = Array.from({ length: TRACK_WINDOW * 2 }, () => ["todo", { op: "view" }] as const);
		expect(collectDetections(calls).map(({ kind, count }) => ({ kind, count }))).toEqual([
			{ kind: "identical", count: 3 },
			{ kind: "identical", count: 6 },
			{ kind: "identical", count: 12 },
			{ kind: "identical", count: 24 },
			{ kind: "identical", count: 48 },
			{ kind: "identical", count: TRACK_WINDOW },
		]);
	});

	it("emits one final similar notice when the tracker window saturates", () => {
		const calls = Array.from(
			{ length: TRACK_WINDOW * 2 },
			(_, index) =>
				[
					"read",
					{ path: "src/app.ts", offset: index * 200 + 1, limit: 200, stablePadding: "x".repeat(200) },
				] as const,
		);
		expect(collectDetections(calls).map(({ kind, count }) => ({ kind, count }))).toEqual([
			{ kind: "similar", count: 5 },
			{ kind: "similar", count: 10 },
			{ kind: "similar", count: 20 },
			{ kind: "similar", count: 40 },
			{ kind: "similar", count: TRACK_WINDOW },
		]);
	});

	it("emits one final cycle notice at the maximum repetitions in the tracker window", () => {
		const gate = new NoticeGate();
		const maximumRepetitions = Math.floor(TRACK_WINDOW / 2);
		const admittedCounts = Array.from({ length: maximumRepetitions - 2 }, (_, index) => index + 3).filter((count) =>
			gate.admit({
				kind: "cycle",
				period: 2,
				count,
				cycleTools: ["eval", "bash_output"],
				fingerprint: "period-2",
			}),
		);
		expect(admittedCounts).toEqual([3, 6, 12, 24, maximumRepetitions]);
	});
});
