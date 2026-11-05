import { describe, expect, it } from "vitest";
import { detectSimilarRun } from "../../src/core/extensions/builtin/loop-guard/detectors.ts";
import { SIMILAR_RUN_THRESHOLD, SIMILARITY_THRESHOLD } from "../../src/core/extensions/builtin/loop-guard/policy.ts";
import type { ToolCallRecord } from "../../src/core/extensions/builtin/loop-guard/tracker.ts";
import { canonicalizeArgs } from "../../src/core/extensions/builtin/loop-guard/tracker.ts";

function rec(toolName: string, args: unknown): ToolCallRecord {
	const argsJson = canonicalizeArgs(args);
	return { toolName, argsJson, signature: `${toolName}\u0000${argsJson}` };
}

function recs(...calls: Array<[string, unknown]>): ToolCallRecord[] {
	return calls.map(([name, args]) => rec(name, args));
}

describe("detectSimilarRun", () => {
	it("returns undefined for productive runs with distinct args", () => {
		const records = recs(
			["bash", { command: "vitest run test/a.test.ts" }],
			["bash", { command: "git status --short" }],
			["bash", { command: "npm run check" }],
			["bash", { command: "rg -n 'loopGuard' packages" }],
			["bash", { command: "node scripts/build.mjs --watch" }],
		);
		expect(detectSimilarRun(records)).toBeUndefined();
	});

	it("returns undefined for distinct read targets with long common path prefixes", () => {
		const basePath =
			"/Users/yeongyu/local-workspaces/senpi/packages/coding-agent/src/core/extensions/builtin/loop-guard";
		const records = recs(
			["read", { path: `${basePath}/detectors.ts` }],
			["read", { path: `${basePath}/notice.ts` }],
			["read", { path: `${basePath}/policy.ts` }],
			["read", { path: `${basePath}/similarity.ts` }],
			["read", { path: `${basePath}/tracker.ts` }],
		);
		expect(detectSimilarRun(records)).toBeUndefined();
	});

	it("returns undefined while the run is all-identical (identical detector owns it)", () => {
		const records = recs(
			...Array.from({ length: SIMILAR_RUN_THRESHOLD }, (): [string, unknown] => ["read", { path: "a.ts" }]),
		);
		expect(detectSimilarRun(records)).toBeUndefined();
	});

	it("fires for near-identical pagination runs at the threshold", () => {
		const records = recs(
			["read", { path: "src/app.ts", offset: 1, limit: 200 }],
			["read", { path: "src/app.ts", offset: 201, limit: 200 }],
			["read", { path: "src/app.ts", offset: 401, limit: 200 }],
			["read", { path: "src/app.ts", offset: 601, limit: 200 }],
			["read", { path: "src/app.ts", offset: 801, limit: 200 }],
		);
		const detection = detectSimilarRun(records);
		expect(detection?.kind).toBe("similar");
		expect(detection?.count).toBe(SIMILAR_RUN_THRESHOLD);
		if (detection?.kind === "similar") {
			expect(detection.similarity).toBeGreaterThanOrEqual(SIMILARITY_THRESHOLD);
		}
	});

	it("returns undefined for polling distinct task targets", () => {
		const records = recs(
			["task_output", { task_id: "st_019fc57c", mode: "status" }],
			["task_output", { task_id: "st_019fc57d", mode: "status" }],
			["task_output", { task_id: "st_019fc57e", mode: "status" }],
			["task_output", { task_id: "st_019fc57f", mode: "status" }],
			["task_output", { task_id: "st_019fc580", mode: "status" }],
		);
		expect(detectSimilarRun(records)).toBeUndefined();
	});

	it.each([
		{
			toolName: "bash_output",
			targets: ["bash_17a", "bash_17b", "bash_17c", "bash_17d", "bash_17e"],
			args: (target: string) => ({ bash_id: target, filter: "", view: "log" }),
		},
		{
			toolName: "lsp_diagnostics",
			targets: ["detectors.ts", "notice.ts", "policy.ts", "similarity.ts", "tracker.ts"],
			args: (target: string) => ({
				filePath: `/Users/yeongyu/local-workspaces/senpi/packages/coding-agent/src/core/extensions/builtin/loop-guard/${target}`,
				severity: "all",
			}),
		},
		{
			toolName: "task_update",
			targets: ["task_17a", "task_17b", "task_17c", "task_17d", "task_17e"],
			args: (target: string) => ({
				team_run_id: "team_123",
				task_id: target,
				status: "in_progress",
				owner: "lead",
			}),
		},
		{
			toolName: "task_send",
			targets: ["st_019fc57a", "st_019fc57b", "st_019fc57c", "st_019fc57d", "st_019fc57e"],
			args: (target: string) => ({
				to: target,
				message: "return status",
				team_run_id: "",
				summary: "",
				all_scope: false,
			}),
		},
	])("returns undefined for distinct $toolName targets", ({ toolName, targets, args }) => {
		expect(detectSimilarRun(targets.map((target) => rec(toolName, args(target))))).toBeUndefined();
	});

	it("fires for repeated polling of the same task target", () => {
		const records = recs(
			["task_output", { task_id: "st_019fc57d", mode: "tail", tail_lines: 20 }],
			["task_output", { task_id: "st_019fc57d", mode: "tail", tail_lines: 40 }],
			["task_output", { task_id: "st_019fc57d", mode: "tail", tail_lines: 60 }],
			["task_output", { task_id: "st_019fc57d", mode: "tail", tail_lines: 80 }],
			["task_output", { task_id: "st_019fc57d", mode: "tail", tail_lines: 100 }],
		);
		const detection = detectSimilarRun(records);
		expect(detection?.kind).toBe("similar");
		expect(detection?.count).toBe(SIMILAR_RUN_THRESHOLD);
	});
});
