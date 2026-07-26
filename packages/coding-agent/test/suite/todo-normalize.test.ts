import { describe, expect, it } from "vitest";
import { normalizeTodoParams } from "../../src/core/extensions/builtin/todotools/normalize.ts";
import type { TodoPhase } from "../../src/core/extensions/builtin/todotools/state.ts";

const emptyPhases: TodoPhase[] = [];
const populatedPhases: TodoPhase[] = [
	{
		name: "Tasks",
		tasks: [{ content: "Existing task", status: "in_progress" }],
	},
];

function expectError(raw: Record<string, unknown>, phases: readonly TodoPhase[] = emptyPhases): string {
	const result = normalizeTodoParams(raw, phases);
	expect(result.entry).toBeUndefined();
	expect(result.error).toBeTypeOf("string");
	return result.error ?? "";
}

describe("normalizeTodoParams", () => {
	describe("R0 blank-target guard", () => {
		it.each([
			["start", "task"],
			["start", "phase"],
			["done", "task"],
			["done", "phase"],
			["drop", "task"],
			["drop", "phase"],
			["rm", "task"],
			["rm", "phase"],
		] as const)("rejects a blank %s %s target", (op, field) => {
			const raw: Record<string, unknown> = { op, [field]: " \t " };
			expect(expectError(raw)).toBe(
				`Blank "${field}" — pass the exact ${field} text, or omit the field entirely for a bulk operation.`,
			);
		});

		it("drops a blank task when a real phase makes the target unambiguous", () => {
			const result = normalizeTodoParams({ op: "done", task: " ", phase: "Tasks" }, populatedPhases);
			expect(result).toEqual({ entry: { op: "done", phase: "Tasks" }, corrections: [] });
		});

		it("drops fx03's blank phase padding when a real task is present", () => {
			const raw = {
				op: "done",
				list: [],
				task: "Confirm temporary 13773 server is offline",
				phase: "",
				items: [],
			};
			const result = normalizeTodoParams(raw, populatedPhases);
			expect(result).toEqual({
				entry: { op: "done", task: "Confirm temporary 13773 server is offline" },
				corrections: [],
			});
			expect(raw).toEqual({
				op: "done",
				list: [],
				task: "Confirm temporary 13773 server is offline",
				phase: "",
				items: [],
			});
		});
	});

	describe("R1 and R-VIEW", () => {
		it("preserves explicit init list=[] clear semantics", () => {
			expect(normalizeTodoParams({ op: "init", list: [] }, populatedPhases)).toEqual({
				entry: { op: "init", list: [] },
				corrections: [],
			});
		});

		it("ignores empty placeholders on operations that do not read them", () => {
			expect(
				normalizeTodoParams(
					{ op: "start", task: "Existing task", list: [], items: [], phase: "" },
					populatedPhases,
				),
			).toEqual({ entry: { op: "start", task: "Existing task" }, corrections: [] });
		});

		it("short-circuits view and ignores every other field", () => {
			expect(
				normalizeTodoParams({ op: "view", append: ["x"], task: " ", list: [{ bad: true }] }, populatedPhases),
			).toEqual({
				entry: { op: "view" },
				corrections: [],
			});
		});
	});

	describe("R2 alias canonicalization", () => {
		it("folds fx12's op-named append alias into items", () => {
			const result = normalizeTodoParams(
				{
					append: [
						"Fix oracle blocker 2 via Agent A: reasoning terminal-path flush + regression — verify by tests green",
						"Fix oracle blocker 1 via Agent B: empty-delta throttle accounting + regression — verify by tests green",
						"Re-review blocker fixes + re-run focused tests + gates — verify exit 0",
						"Re-submit delta to same oracle — verify by APPROVE",
					],
					op: "append",
					phase: "Tasks",
				},
				populatedPhases,
			);
			expect(result.entry).toEqual({
				op: "append",
				phase: "Tasks",
				items: [
					"Fix oracle blocker 2 via Agent A: reasoning terminal-path flush + regression — verify by tests green",
					"Fix oracle blocker 1 via Agent B: empty-delta throttle accounting + regression — verify by tests green",
					"Re-review blocker fixes + re-run focused tests + gates — verify exit 0",
					"Re-submit delta to same oracle — verify by APPROVE",
				],
			});
			expect(result.corrections).toHaveLength(1);
			expect(result.corrections[0]).toContain('"append"');
		});

		it("uses an alias as the missing-op candidate", () => {
			const result = normalizeTodoParams({ init: ["First task"] }, emptyPhases);
			expect(result.entry).toEqual({ op: "init", items: ["First task"] });
			expect(result.corrections).toHaveLength(1);
		});

		it("rejects a conflicting alias operation", () => {
			expect(expectError({ op: "init", append: ["x"] })).toContain("conflicting shapes");
		});

		it("rejects alias and items shapes together", () => {
			expect(expectError({ op: "append", append: ["x"], items: ["y"] })).toContain("conflicting shapes");
		});

		it("rejects two non-empty aliases at once", () => {
			expect(expectError({ init: ["x"], append: ["y"] })).toContain("conflicting shapes");
		});
	});

	describe("R3 op inference and conflicts", () => {
		it("infers init from the verbatim fx04-shaped list payload", () => {
			const raw = {
				list: [
					{
						items: [
							"W1-A: migration 0016 + drizzle schema + repos types/mapping + inline test DDL sweep — verify tsc + full bun test green",
							"W1-B: src/lib/cost-limits.ts + unit tests RED→GREEN — verify bun test tests/unit/cost-limits.test.ts",
						],
						phase: "Foundation",
					},
				],
			};
			const result = normalizeTodoParams(raw, emptyPhases);
			expect(result.entry).toEqual({ op: "init", list: raw.list });
			expect(result.corrections[0]).toContain('interpreted as "init"');
			expect(result.corrections[0]).toContain('{"op":"init","list":[...]}');
		});

		it("infers init from the verbatim fx02 items-only payload on an empty list", () => {
			const raw = {
				items: [
					"Wave1: DNS/WHOIS/TLS/HTTP/crt.sh fingerprint via eval — verify outputs in notepad",
					"Wave2: fetch ydtour50.sbs content Tier1 engine, escalate CloakBrowser if blocked — verify captured text+screenshot",
					"Wave3: enumerate >=3 sibling mirror domains — verify list with sources",
					"Synthesize final report with evidence refs — verify all criteria PASS",
				],
			};
			const result = normalizeTodoParams(raw, emptyPhases);
			expect(result.entry).toEqual({ op: "init", items: raw.items });
			expect(result.corrections[0]).toContain('interpreted as "init"');
		});

		it("infers append from items and a non-blank phase", () => {
			const result = normalizeTodoParams({ items: ["x"], phase: "Later" }, emptyPhases);
			expect(result.entry).toEqual({ op: "append", phase: "Later", items: ["x"] });
			expect(result.corrections[0]).toContain('interpreted as "append"');
		});

		it("does not guess init versus append on a populated list", () => {
			const error = expectError({ items: ["x"] }, populatedPhases);
			expect(error).toContain('{"op":"init","list":[...]}');
			expect(error).toContain('{"op":"append","phase":"<active phase>","items":[...]}');
		});

		it("rejects list plus items before alias inference can choose a priority", () => {
			expect(expectError({ list: [{ phase: "A", items: ["x"] }], append: ["y"] })).toContain("conflicting shapes");
		});

		it("rejects direct list and items conflicts", () => {
			expect(expectError({ list: [{ phase: "A", items: ["x"] }], items: ["y"] })).toContain("conflicting shapes");
		});

		it("rejects missing-op calls without a non-empty signal", () => {
			expect(expectError({ list: [], items: [], phase: " " })).toBe(
				'Missing "op". Example: {"op":"init","list":[{"phase":"Setup","items":["..."]}]}',
			);
		});
	});

	describe("R4 field compatibility", () => {
		it("rejects an invalid op from fx05", () => {
			expect(expectError({ op: "Study kimi-k3-unlocked full implementation" })).toContain('Invalid "op"');
		});

		it("rejects TodoWrite residue on done before it can bulk-complete", () => {
			expect(expectError({ op: "done", list: [{ phase: "A", items: ["x"] }] }, populatedPhases)).toContain(
				"conflicting shapes",
			);
		});

		it("rejects explicit init clear combined with items", () => {
			expect(expectError({ op: "init", list: [], items: ["x"] })).toContain("conflicting shapes");
		});

		it("passes fx17's duplicate-phase init shape through for the merge layer", () => {
			const raw = {
				op: "init",
				list: [
					{ phase: "Dockerfile", items: ["Dockerfile secret 제거 + 가드 반전 GREEN"] },
					{
						phase: "Ship",
						items: [
							"커밋 + push + PR 생성",
							"CI green + 머지(사용자 사전 승인: 이 작업 병합)",
							"deploy-dev 트리거 관찰: Build Succeeded?",
						],
						phase2: "Verify",
					},
					{ phase: "Dockerfile", items: ["dev uptime 리셋 + memory 활성화 확인"], items2: [] },
				],
			};
			expect(normalizeTodoParams(raw, emptyPhases)).toEqual({
				entry: {
					op: "init",
					list: [
						{ phase: "Dockerfile", items: ["Dockerfile secret 제거 + 가드 반전 GREEN"] },
						{
							phase: "Ship",
							items: [
								"커밋 + push + PR 생성",
								"CI green + 머지(사용자 사전 승인: 이 작업 병합)",
								"deploy-dev 트리거 관찰: Build Succeeded?",
							],
						},
						{ phase: "Dockerfile", items: ["dev uptime 리셋 + memory 활성화 확인"] },
					],
				},
				corrections: [],
			});
		});

		it("canonicalizes alias append with a blank phase to an absent phase", () => {
			const result = normalizeTodoParams({ op: "append", append: ["x"], phase: " \n " }, emptyPhases);
			expect(result.entry).toEqual({ op: "append", items: ["x"] });
			expect(result.corrections).toHaveLength(1);
		});

		it("keeps task precedence when done receives both targets", () => {
			expect(normalizeTodoParams({ op: "done", task: "Existing task", phase: "Tasks" }, populatedPhases)).toEqual({
				entry: { op: "done", task: "Existing task", phase: "Tasks" },
				corrections: [],
			});
		});

		it.each([
			[{ op: "init", task: "x" }, "init"],
			[{ op: "start", phase: "Tasks" }, "start"],
			[{ op: "start", list: [{ phase: "A", items: ["x"] }] }, "start"],
			[{ op: "drop", items: ["x"] }, "drop"],
			[{ op: "rm", list: [{ phase: "A", items: ["x"] }] }, "rm"],
			[{ op: "append", list: [{ phase: "A", items: ["x"] }] }, "append"],
			[{ op: "append", task: "x", items: ["y"] }, "append"],
		])("rejects incoherent %s fields", (raw, _op) => {
			expect(expectError(raw)).toContain("conflicting shapes");
		});
	});
});
