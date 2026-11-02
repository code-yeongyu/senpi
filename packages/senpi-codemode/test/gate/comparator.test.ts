import { describe, expect, it } from "vitest";
import { compareReports } from "../../scripts/gate-compare.ts";
import type { GateReport } from "../../scripts/gate-report.ts";

const baseline: GateReport = {
	version: 1,
	prompts: {
		fixture: { description: "abc", promptSnippet: "cell", promptGuidelines: ["batch"], bytes: 12, tokens: 3 },
	},
	schemas: { js: '{"type":"object"}' },
	helperCensus: { js: ["phase", "print"] },
	runtimes: [
		{ id: "js-bun", available: true },
		{ id: "rb", available: true },
	],
	invariants: { terminalEvents: 1 },
	imports: { extension: ["node:fs"] },
	observations: {
		platform: "darwin",
		legacyContracts: { "fixture/keeps output": "passed", "fixture/windows case": "pending" },
	},
};

describe("eval regression report comparison", () => {
	it("reports every regression when helpers, prompt bytes and a required runtime change", () => {
		// Given: three independent regressions in one report.
		const changed: GateReport = {
			...baseline,
			helperCensus: { js: ["print"] },
			prompts: { fixture: { ...baseline.prompts.fixture, description: "abd" } },
			runtimes: [
				{ id: "js-bun", available: true },
				{ id: "rb", available: false },
			],
		};
		// When
		const result = compareReports({ baseline, report: changed, additions: [] });
		// Then
		expect(result.exitCode).toBe(1);
		expect(result.failures).toEqual([
			"required interpreter missing: rb",
			"helper census: js removed [phase]",
			"prompt surface: fixture changed",
		]);
	});

	it("accepts an identical report", () => {
		// Given / When
		const result = compareReports({ baseline, report: structuredClone(baseline), additions: [] });
		// Then
		expect(result).toEqual({ exitCode: 0, failures: [], additions: [] });
	});

	it("fails unmeasured sections without fabricating removed contracts", () => {
		const report: GateReport = {
			...baseline,
			helperCensus: {},
			runtimes: [],
			invariants: {},
			imports: {},
			observations: { platform: "darwin" },
			unmeasured: ["helperCensus/js", "runtimes", "invariants/terminalEvents", "imports", "legacyContracts"],
		};
		const result = compareReports({ baseline, report, additions: [] });
		expect(result.exitCode).toBe(1);
		expect(result.failures).toEqual(report.unmeasured?.map((section) => `unmeasured section: ${section}`));
	});

	it("rejects unreviewed additions and never allowlists a removal", () => {
		// Given
		const changed = { ...baseline, helperCensus: { js: ["print", "wait"] } };
		// When
		const result = compareReports({ baseline, report: changed, additions: ["helperCensus/js/wait"] });
		// Then
		expect(result.failures).toEqual(["helper census: js removed [phase]"]);
		expect(result.additions).toEqual(["helperCensus/js/wait"]);
		const unreviewed = compareReports({ baseline, report: changed, additions: [] });
		expect(unreviewed.failures).toContain("unreviewed addition: helperCensus/js/wait");
	});

	it("permits a reviewed module addition without allowing a removed import", () => {
		// Given: an intentional module addition with its exact phase-scoped approval.
		const added = { ...baseline, imports: { extension: ["node:fs", "node:path"] } };
		// When / Then: approval applies to the module, never to a lost dependency.
		const reviewed = compareReports({ baseline, report: added, additions: ["imports/extension/node:path"] });
		expect(reviewed.exitCode).toBe(0);
		expect(reviewed.additions).toContain("imports/extension/node:path");
		expect(compareReports({ baseline, report: added, additions: [] }).exitCode).toBe(1);
		const removed = { ...baseline, imports: { extension: ["node:path"] } };
		expect(compareReports({ baseline, report: removed, additions: ["imports/extension/node:path"] }).exitCode).toBe(
			1,
		);
	});

	it("rejects a missing report section instead of treating it as an additive change", () => {
		// Given
		const changed = { ...baseline, schemas: {} };
		// When
		const result = compareReports({ baseline, report: changed, additions: ["schemas/js"] });
		// Then
		expect(result.failures).toContain("schema surface: js removed");
	});

	it.each(["removed", "renamed"])("rejects a %s legacy scenario even when the remaining suite passes", (change) => {
		// Given: the suite succeeds but loses a baseline scenario.
		const legacyContracts =
			change === "removed"
				? { "fixture/windows case": "pending" }
				: { "fixture/renamed output": "passed", "fixture/windows case": "pending" };
		// When
		const result = compareReports({
			baseline,
			report: { ...baseline, observations: { platform: "linux", legacyContracts } },
			additions: [],
		});
		// Then
		expect(result.exitCode).toBe(1);
		expect(result.failures).toContain("legacy contract: fixture/keeps output removed");
	});

	it("permits platform-dependent skip outcomes without losing a scenario", () => {
		// Given: the same scenarios run on another platform.
		const legacyContracts = { "fixture/keeps output": "passed", "fixture/windows case": "passed" };
		// When
		const result = compareReports({
			baseline,
			report: { ...baseline, observations: { platform: "linux", legacyContracts } },
			additions: [],
		});
		// Then
		expect(result.exitCode).toBe(0);
	});

	it("rejects silently skipping a legacy scenario on the same platform", () => {
		// Given: a formerly passing test no longer executes.
		const report = {
			...baseline,
			observations: {
				platform: "darwin",
				legacyContracts: { "fixture/keeps output": "pending", "fixture/windows case": "pending" },
			},
		};
		// When
		const result = compareReports({ baseline, report, additions: [] });
		// Then
		expect(result.failures).toContain("legacy contract: fixture/keeps output outcome changed");
	});
});
