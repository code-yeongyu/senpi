import { describe, expect, it } from "vitest";
import {
	detectCycle,
	detectIdenticalRun,
	detectLoop,
	NoticeGate,
} from "../../src/core/extensions/builtin/loop-guard/detectors.ts";
import { buildLoopGuardReminder } from "../../src/core/extensions/builtin/loop-guard/notice.ts";
import { IDENTICAL_RUN_THRESHOLD, SIMILARITY_THRESHOLD } from "../../src/core/extensions/builtin/loop-guard/policy.ts";
import {
	bigramCounts,
	diceSimilarity,
	meanAdjacentSimilarity,
} from "../../src/core/extensions/builtin/loop-guard/similarity.ts";
import type { ToolCallRecord } from "../../src/core/extensions/builtin/loop-guard/tracker.ts";
import { canonicalizeArgs, ToolCallTracker } from "../../src/core/extensions/builtin/loop-guard/tracker.ts";

function rec(toolName: string, args: unknown): ToolCallRecord {
	const argsJson = canonicalizeArgs(args);
	return { toolName, argsJson, signature: `${toolName}\u0000${argsJson}` };
}

function recs(...calls: Array<[string, unknown]>): ToolCallRecord[] {
	return calls.map(([name, args]) => rec(name, args));
}

describe("canonicalizeArgs", () => {
	it("is insensitive to key order", () => {
		expect(canonicalizeArgs({ a: 1, b: { d: 2, c: [3] } })).toBe(canonicalizeArgs({ b: { c: [3], d: 2 }, a: 1 }));
	});

	it("defaults missing args to an empty object", () => {
		expect(canonicalizeArgs(undefined)).toBe(canonicalizeArgs({}));
	});
});

describe("similarity metrics", () => {
	it("scores identical strings at 1", () => {
		expect(diceSimilarity(bigramCounts("abcdef"), bigramCounts("abcdef"))).toBe(1);
	});

	it("scores disjoint strings at 0", () => {
		expect(diceSimilarity(bigramCounts("aaaa"), bigramCounts("zzzz"))).toBe(0);
	});

	it("meanAdjacentSimilarity separates pagination from distinct queries", () => {
		const pagination = meanAdjacentSimilarity([
			'{"path":"src/app.ts","offset":1,"limit":200}',
			'{"path":"src/app.ts","offset":201,"limit":200}',
			'{"path":"src/app.ts","offset":401,"limit":200}',
		]);
		const distinct = meanAdjacentSimilarity([
			'{"query":"tool call loop detection"}',
			'{"query":"typescript vitest fake timers"}',
			'{"query":"kubernetes pod eviction policy"}',
		]);
		expect(pagination).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
		expect(distinct).toBeLessThan(SIMILARITY_THRESHOLD);
	});
});

describe("detectIdenticalRun", () => {
	it("returns undefined below the threshold", () => {
		const records = recs(["read", { path: "a.ts" }], ["read", { path: "a.ts" }]);
		expect(detectIdenticalRun(records)).toBeUndefined();
	});

	it("fires at the threshold with the full run count", () => {
		const records = recs(
			["bash", { command: "echo 1" }],
			["read", { path: "a.ts" }],
			["read", { path: "a.ts" }],
			["read", { path: "a.ts" }],
		);
		const detection = detectIdenticalRun(records);
		expect(detection?.kind).toBe("identical");
		if (detection?.kind !== "identical") return;
		expect(detection.count).toBe(IDENTICAL_RUN_THRESHOLD);
		expect(detection.toolName).toBe("read");
	});

	it("counts key-order-insensitive duplicates as identical", () => {
		const records = recs(
			["read", { path: "a.ts", limit: 50 }],
			["read", { limit: 50, path: "a.ts" }],
			["read", { path: "a.ts", limit: 50 }],
		);
		expect(detectIdenticalRun(records)?.count).toBe(3);
	});
});

describe("detectCycle", () => {
	it("returns undefined for a pattern repeated only twice", () => {
		const records = recs(
			["read", { path: "a" }],
			["bash", { command: "x" }],
			["read", { path: "a" }],
			["bash", { command: "x" }],
		);
		expect(detectCycle(records)).toBeUndefined();
	});

	it("fires on a period-2 cycle repeated three times", () => {
		const cycle: Array<[string, unknown]> = [
			["eval", { code: "poll()" }],
			["bash_output", { bash_id: "s1" }],
		];
		const records = recs(...cycle, ...cycle, ...cycle);
		const detection = detectCycle(records);
		expect(detection?.kind).toBe("cycle");
		if (detection?.kind !== "cycle") return;
		expect(detection.period).toBe(2);
		expect(detection.count).toBe(3);
	});

	it("tolerates a leading prefix before the cycle", () => {
		const cycle: Array<[string, unknown]> = [
			["a", { n: 1 }],
			["b", { n: 2 }],
		];
		const records = recs(["seed", { n: 0 }], ...cycle, ...cycle, ...cycle);
		expect(detectCycle(records)?.kind).toBe("cycle");
	});

	it("ignores all-identical windows (identical detector owns period 1)", () => {
		const records = recs(
			["read", { path: "a" }],
			["read", { path: "a" }],
			["read", { path: "a" }],
			["read", { path: "a" }],
		);
		expect(detectCycle(records)).toBeUndefined();
	});

	it("fires on a period-3 cycle", () => {
		const cycle: Array<[string, unknown]> = [
			["read", { path: "a" }],
			["edit", { path: "a", n: 1 }],
			["bash", { command: "tsc" }],
		];
		const records = recs(...cycle, ...cycle, ...cycle);
		const detection = detectCycle(records);
		expect(detection?.kind).toBe("cycle");
		if (detection?.kind !== "cycle") return;
		expect(detection.period).toBe(3);
		expect(detection.count).toBe(3);
	});
});

describe("NoticeGate escalation", () => {
	it("suppresses intermediate counts and re-fires at the doubled count", () => {
		const gate = new NoticeGate();
		const records = recs(["read", { path: "a.ts" }], ["read", { path: "a.ts" }], ["read", { path: "a.ts" }]);
		expect(detectLoop(records, gate)?.kind).toBe("identical");
		records.push(rec("read", { path: "a.ts" }), rec("read", { path: "a.ts" }));
		expect(detectLoop(records, gate)).toBeUndefined();
		records.push(rec("read", { path: "a.ts" }));
		expect(detectLoop(records, gate)?.count).toBe(6);
	});

	it("resumes firing when the pattern breaks and re-forms", () => {
		const gate = new NoticeGate();
		const first = recs(["read", { path: "a.ts" }], ["read", { path: "a.ts" }], ["read", { path: "a.ts" }]);
		expect(detectLoop(first, gate)?.kind).toBe("identical");
		first.push(rec("bash", { command: "ls" }));
		expect(detectLoop(first, gate)).toBeUndefined();
		first.push(rec("read", { path: "b.ts" }), rec("read", { path: "b.ts" }), rec("read", { path: "b.ts" }));
		expect(detectLoop(first, gate)?.kind).toBe("identical");
	});

	it("prefers the identical detector over similar and cycle", () => {
		const gate = new NoticeGate();
		const records = recs(...Array.from({ length: 5 }, (): [string, unknown] => ["read", { path: "a.ts" }]));
		expect(detectLoop(records, gate)?.kind).toBe("identical");
	});
});

describe("ToolCallTracker", () => {
	it("caps the window at the policy limit", () => {
		const tracker = new ToolCallTracker();
		for (let i = 0; i < 100; i++) tracker.record("bash", { command: `cmd ${i}` });
		expect(tracker.records.length).toBe(64);
	});

	it("reset clears the records", () => {
		const tracker = new ToolCallTracker();
		tracker.record("bash", { command: "x" });
		tracker.reset();
		expect(tracker.records.length).toBe(0);
	});
});

describe("buildLoopGuardReminder", () => {
	it("wraps every kind in system-reminder tags with the kind-specific headline", () => {
		const identical = buildLoopGuardReminder({ kind: "identical", toolName: "read", count: 3, fingerprint: "fp" });
		expect(identical).toContain("<system-reminder>");
		expect(identical).toContain("IDENTICAL TOOL CALLS");
		expect(identical).toContain("`read` 3 times");

		const similar = buildLoopGuardReminder({
			kind: "similar",
			toolName: "read",
			count: 5,
			similarity: 0.92,
			fingerprint: "fp",
		});
		expect(similar).toContain("NEAR-IDENTICAL TOOL CALLS");
		expect(similar).toContain("92%");

		const cycle = buildLoopGuardReminder({
			kind: "cycle",
			period: 2,
			count: 3,
			cycleTools: ["eval", "bash_output"],
			fingerprint: "fp",
		});
		expect(cycle).toContain("REPEATING TOOL-CALL PATTERN");
		expect(cycle).toContain("[eval -> bash_output] 3 times");
	});
});
