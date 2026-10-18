import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { baselineApprovals, readBaseBaseline, reviewBaselineChanges } from "../../scripts/gate-baseline-review.ts";
import type { GateReport } from "../../scripts/gate-report.ts";

const base: GateReport = {
	version: 1,
	prompts: {
		fixture: { description: "abc", promptSnippet: "cell", promptGuidelines: ["batch"], bytes: 12, tokens: 3 },
	},
	schemas: { js: '{"type":"object","required":["code"]}' },
	helperCensus: { js: ["phase", "print"] },
	runtimes: [{ id: "js-bun", available: true }],
	invariants: { terminalEvents: 1 },
	imports: { extension: ["node:fs", "src/old-module.ts"] },
	observations: { platform: "linux", legacyContracts: { "fixture/keeps output": "passed" } },
};

const changedSchema = '{"type":"object","required":["code","language"]}';
const withSchema = (schema: string): GateReport => ({ ...structuredClone(base), schemas: { js: schema } });
const schemaChange = [{ key: "schemas/js", reason: "language becomes required (fixture)" }];

describe("Given a pull request that changes a tracked eval schema field", () => {
	it("When it ships the recomputed baseline and lists the change, then the review passes", () => {
		const head = withSchema(changedSchema);

		expect(
			reviewBaselineChanges({ base, committed: head, report: head, changes: schemaChange, additions: [] }),
		).toEqual([]);
	});

	it("When the same baseline change is not listed under changes, then the review fails naming the cell", () => {
		const head = withSchema(changedSchema);

		expect(reviewBaselineChanges({ base, committed: head, report: head, changes: [], additions: [] })).toEqual([
			'unreviewed baseline change: schemas/js (list it under "changes" in test/gate/allowlist.json with a reason)',
		]);
	});

	it("When the baseline is hand-edited to a value the head does not measure, then the review fails", () => {
		const committed = withSchema('{"type":"object","required":["code","lang"]}');
		const head = withSchema(changedSchema);

		expect(reviewBaselineChanges({ base, committed, report: head, changes: schemaChange, additions: [] })).toEqual([
			"baseline change to schemas/js does not match the head measurement",
		]);
	});

	it("When the baseline also edits an unrelated cell the head did not change, then the review fails for that cell", () => {
		const committed: GateReport = { ...withSchema(changedSchema), invariants: { terminalEvents: 2 } };
		const head = withSchema(changedSchema);

		expect(reviewBaselineChanges({ base, committed, report: head, changes: schemaChange, additions: [] })).toEqual([
			'unreviewed baseline change: invariants/terminalEvents (list it under "changes" in test/gate/allowlist.json with a reason)',
			"baseline change to invariants/terminalEvents does not match the head measurement",
		]);
	});
});

describe("Given a set section in the baseline", () => {
	const withoutOldModule = (): GateReport => ({ ...structuredClone(base), imports: { extension: ["node:fs"] } });
	const removal = [{ key: "imports/extension/src/old-module.ts", reason: "module deleted (fixture)" }];

	it("When a removal is not listed, then it fails like an edit", () => {
		const head = withoutOldModule();

		expect(reviewBaselineChanges({ base, committed: head, report: head, changes: [], additions: [] })).toEqual([
			'unreviewed baseline change: imports/extension/src/old-module.ts (list it under "changes" in test/gate/allowlist.json with a reason)',
		]);
	});

	it("When a listed removal is no longer measured by the head, then it passes", () => {
		const head = withoutOldModule();

		expect(reviewBaselineChanges({ base, committed: head, report: head, changes: removal, additions: [] })).toEqual(
			[],
		);
	});

	it("When a listed removal is still measured by the head, then it fails", () => {
		expect(
			reviewBaselineChanges({ base, committed: withoutOldModule(), report: base, changes: removal, additions: [] }),
		).toEqual(["baseline removes imports/extension/src/old-module.ts, but the head still measures it"]);
	});

	it("When the baseline adds a member the head measures and this PR lists it under additions, then it passes", () => {
		const head: GateReport = { ...structuredClone(base), helperCensus: { js: ["phase", "print", "wait"] } };

		expect(
			reviewBaselineChanges({
				base,
				committed: head,
				report: head,
				changes: [],
				additions: ["helperCensus/js/wait"],
			}),
		).toEqual([]);
	});

	it("When the PR writes new cells into its own baseline without listing them, then each fails as an unreviewed addition", () => {
		const head: GateReport = {
			...structuredClone(base),
			imports: { extension: ["node:fs", "src/old-module.ts", "src/environments/py-installer.ts"] },
			prompts: {
				...structuredClone(base.prompts),
				"gpt-new": { description: "x", promptSnippet: "y", promptGuidelines: [], bytes: 2, tokens: 1 },
			},
		};

		expect(reviewBaselineChanges({ base, committed: head, report: head, changes: [], additions: [] })).toEqual([
			'unreviewed baseline addition: prompts/gpt-new (list it under "additions" in test/gate/allowlist.json)',
			'unreviewed baseline addition: imports/extension/src/environments/py-installer.ts (list it under "additions" in test/gate/allowlist.json)',
		]);
	});

	it("When the baseline adds a member the head does not measure, then it fails", () => {
		const committed: GateReport = { ...structuredClone(base), helperCensus: { js: ["phase", "print", "wait"] } };

		expect(
			reviewBaselineChanges({ base, committed, report: base, changes: [], additions: ["helperCensus/js/wait"] }),
		).toEqual(["baseline addition helperCensus/js/wait does not match the head measurement"]);
	});

	it("When a legacy contract outcome is recorded on another platform, then only its presence is compared", () => {
		const committed: GateReport = {
			...structuredClone(base),
			observations: {
				platform: "darwin",
				legacyContracts: { "fixture/keeps output": "passed", "fixture/new case": "passed" },
			},
		};
		const head: GateReport = {
			...structuredClone(base),
			observations: {
				platform: "linux",
				legacyContracts: { "fixture/keeps output": "passed", "fixture/new case": "skipped" },
			},
		};

		expect(
			reviewBaselineChanges({
				base,
				committed,
				report: head,
				changes: [],
				additions: ["legacyContracts/fixture/new case"],
			}),
		).toEqual([]);
	});
});

describe("Given allowlist entries merged by earlier pull requests", () => {
	const earlier = {
		nodes: {
			"13": {
				additions: ["imports/extension/src/a.ts"],
				changes: [{ key: "schemas/js", reason: "rename (earlier PR)" }],
			},
		},
	};

	it("When a later PR edits the same cell again without a new entry, then the earlier entry does not approve it", () => {
		const fresh = baselineApprovals({ base: earlier, head: earlier });
		const head = withSchema(changedSchema);

		expect(fresh).toEqual({ changes: [], additions: ["imports/extension/src/a.ts"] });
		expect(reviewBaselineChanges({ base, committed: head, report: head, ...fresh })).toEqual([
			'unreviewed baseline change: schemas/js (list it under "changes" in test/gate/allowlist.json with a reason)',
		]);
	});

	it("When the later PR adds its own entry for the cell, then that entry approves it", () => {
		const head = {
			nodes: {
				...earlier.nodes,
				"35": {
					additions: ["imports/extension/src/b.ts"],
					changes: [{ key: "schemas/js", reason: "language becomes required" }],
				},
			},
		};
		const fresh = baselineApprovals({ base: earlier, head });

		expect(fresh).toEqual({
			changes: [{ key: "schemas/js", reason: "language becomes required" }],
			additions: ["imports/extension/src/a.ts", "imports/extension/src/b.ts"],
		});
		expect(
			reviewBaselineChanges({
				base,
				committed: withSchema(changedSchema),
				report: withSchema(changedSchema),
				...fresh,
			}),
		).toEqual([]);
	});

	it("When a later PR re-records the baseline with an addition an earlier PR approved, then the review passes", () => {
		const recorded: GateReport = {
			...structuredClone(base),
			imports: { extension: [...(base.imports.extension ?? []), "src/a.ts"] },
		};

		expect(
			reviewBaselineChanges({
				base,
				committed: recorded,
				report: recorded,
				...baselineApprovals({ base: earlier, head: earlier }),
			}),
		).toEqual([]);
	});

	it("When the base has no allowlist file, then every head entry counts as new", () => {
		expect(baselineApprovals({ base: undefined, head: earlier })).toEqual({
			changes: [{ key: "schemas/js", reason: "rename (earlier PR)" }],
			additions: ["imports/extension/src/a.ts"],
		});
	});
});

describe("Given where the base baseline comes from", () => {
	const roots: string[] = [];
	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	async function repoWithBaseline(): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "senpi-gate-base-"));
		roots.push(root);
		const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
		git("init", "-q", "-b", "main");
		git("config", "user.email", "fixture@example.invalid");
		git("config", "user.name", "fixture");
		await mkdir(join(root, "gate"), { recursive: true });
		await writeFile(join(root, "gate", "baseline.json"), JSON.stringify(base));
		git("add", ".");
		git("commit", "-q", "-m", "base");
		return root;
	}

	it("When a pull request run cannot resolve its merge base, then it fails closed with the reason", async () => {
		const root = await repoWithBaseline();

		await expect(
			readBaseBaseline({ baselinePath: join(root, "gate", "baseline.json"), env: { GITHUB_BASE_REF: "main" } }),
		).rejects.toThrow(/cannot resolve the merge base with origin\/main.*fetch-depth: 0/s);
	});

	it("When a pull request run resolves its merge base, then it returns the baseline as committed there", async () => {
		const root = await repoWithBaseline();
		execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });
		await writeFile(join(root, "gate", "baseline.json"), JSON.stringify(withSchema(changedSchema)));
		execFileSync("git", ["commit", "-q", "-am", "head"], { cwd: root });

		const resolved = await readBaseBaseline({
			baselinePath: join(root, "gate", "baseline.json"),
			env: { GITHUB_BASE_REF: "main" },
		});

		expect(resolved?.base.schemas).toEqual(base.schemas);
	});

	it("When a local run is outside a pull request and names no base ref, then today's behaviour is kept", async () => {
		const root = await repoWithBaseline();

		await expect(
			readBaseBaseline({ baselinePath: join(root, "gate", "baseline.json"), env: {} }),
		).resolves.toBeUndefined();
	});
});
