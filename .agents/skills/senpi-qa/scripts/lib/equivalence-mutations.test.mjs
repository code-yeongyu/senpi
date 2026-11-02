// EQ mutation verdicts (plan P0-05d): the shipped manifest covers every row of the plan's mutation table, a mutation the
// EQ does not catch is a failure, and DEFERRED / NO_B0 rows are reported without ever counting as proof.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cases } from "../../scenarios/fused-equivalence/cases/index.mjs";
import { mutations } from "../../scenarios/fused-equivalence/mutations/manifest.mjs";
import { patchApplies } from "./equivalence-mutation-scratch.mjs";
import {
	classifyMutation,
	planRow,
	renderTable,
	runExitCode,
	STATUS,
	validateManifest,
} from "./equivalence-mutations.mjs";
import { TUI_CASE_IDS } from "./equivalence-tui-cases.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PATCH_DIR = join(here, "..", "..", "scenarios", "fused-equivalence", "mutations");
const REPO = join(here, "..", "..", "..", "..", "..");
const CONTEXT = { caseIds: cases.map((c) => c.id), patchDir: PATCH_DIR, tuiCaseIds: TUI_CASE_IDS };

/** Plan §6.4 "Mutation evidence (P0-05d)": the N14 rows plus the E25 and E30 rows. */
const PLAN_ROWS = [
	"dropped prompt segment",
	"swapped model",
	"dropped declaration",
	"dropped custom header",
	"swapped synthetic credentials",
	"wrong effect target in another dir",
	"wrong effect target in the same sandbox",
	"reordered effects",
	"merged IDs",
	"removed widget/dialog",
	"broken desktop render",
	"interrupted call re-run on resume (E25)",
	"tool result delivered to the other session (E30)",
];

const ROW = Object.freeze({
	id: "x-row",
	row: "swapped model",
	observation: "O2",
	surface: "rpc",
	patch: "o2-swapped-model.patch",
	cases: ["E01"],
	expect: { E01: /^\$\.O2\[0\]\.model: golden="mock-model"/ },
});
const PASSING = new Map([["E01", "PASS"]]);
const CLEAN = { clean: true, reapplies: true };
const failed = (diffs) => ({ exitCode: 1, results: [{ id: "E01", pass: false, diffs, repeatDiffs: [] }] });

test("the shipped manifest is valid and covers each plan row exactly once", () => {
	assert.deepEqual(validateManifest(mutations, CONTEXT), []);
	assert.deepEqual(
		mutations.map((m) => m.row),
		PLAN_ROWS,
	);
});

test("every shipped patch applies to this tree", () => {
	for (const m of mutations.filter((row) => row.patch))
		assert.ok(patchApplies(REPO, join(PATCH_DIR, m.patch)), `${m.patch} does not apply`);
});

test("the manifest rejects a row without a patch, an expectation, a known case or a deferred owner", () => {
	const broken = [
		{ ...ROW, id: "a", patch: "missing.patch" },
		{ ...ROW, id: "b", expect: {} },
		{ ...ROW, id: "c", cases: ["E99"], expect: { E99: /x/ } },
		{ ...ROW, id: "d", surface: "tui", cases: ["E02"], expect: { E02: /x/ } },
		{ id: "e", row: "r", observation: "O8 desktop", surface: "desktop", deferred: { owner: "P0-07b" } },
	];
	const problems = validateManifest(broken, CONTEXT).join("\n");
	for (const fragment of [
		"(a): patch file missing",
		"(b): expect.E01 must be a RegExp",
		"(c): unknown case E99",
		"(d): E02 has no TUI drive",
		"(e): deferred.reason is required",
	])
		assert.match(problems, new RegExp(fragment.replace(/[().]/g, "\\$&")));
});

test("planRow runs a recorded cell, defers a listed one and reports a surface with no goldens as NO_B0", () => {
	const eqDir = mkdtempSync(join(tmpdir(), "eq-mutations-plan-"));
	try {
		mkdirSync(join(eqDir, "golden", "linux-x64"), { recursive: true });
		writeFileSync(join(eqDir, "golden", "linux-x64", "E01.json"), "{}\n");
		const entry = {
			platform: "linux-x64",
			case: "E25",
			mode: "rpc",
			owner: "o",
			issue: "https://github.com/a/b/issues/1",
			due: "d",
		};
		const plan = (m) => planRow(m, { platform: "linux-x64", deferredGoldens: [entry], eqDir });
		assert.deepEqual(plan(ROW).runnable, ["E01"]);
		const e25 = plan({ ...ROW, cases: ["E25"] });
		assert.equal(e25.status, STATUS.DEFERRED);
		assert.match(e25.note, /E25 DEFERRED\(o, https:\/\/github\.com\/a\/b\/issues\/1\)/);
		assert.equal(plan({ ...ROW, cases: ["E02"] }).status, STATUS.ERROR);
		assert.equal(plan({ ...ROW, surface: "tui" }).status, STATUS.NO_B0);
		assert.equal(plan(mutations.find((m) => m.deferred)).status, STATUS.DEFERRED);
	} finally {
		rmSync(eqDir, { recursive: true, force: true });
	}
});

test("a mutation is KILLED only when each case FAILS with the expected diff row", () => {
	const row = { path: "$.O2[0].model", golden: "mock-model", actual: "mock-model-b" };
	const killed = classifyMutation(ROW, { runnable: ["E01"], baseline: PASSING, run: failed([row]), revert: CLEAN });
	assert.equal(killed.status, STATUS.KILLED);
	assert.equal(killed.cases[0].match, '$.O2[0].model: golden="mock-model" actual="mock-model-b"');
	const other = { path: "$.O1[0].body.model", golden: "mock-model", actual: "mock-model-b" };
	const wrong = classifyMutation(ROW, { runnable: ["E01"], baseline: PASSING, run: failed([other]), revert: CLEAN });
	assert.equal(wrong.status, STATUS.WRONG_FAILURE);
});

test("a mutation the EQ passes is SURVIVED: the EQ is blind to it", () => {
	const run = { exitCode: 0, results: [{ id: "E01", pass: true, diffs: [], repeatDiffs: [] }] };
	assert.equal(
		classifyMutation(ROW, { runnable: ["E01"], baseline: PASSING, run, revert: CLEAN }).status,
		STATUS.SURVIVED,
	);
});

test("an unproven baseline, a dirty revert or a crashed harness is never a kill", () => {
	const run = failed([{ path: "$.O2[0].model", golden: "mock-model", actual: "mock-model-b" }]);
	const verdict = (over) =>
		classifyMutation(ROW, { runnable: ["E01"], baseline: PASSING, run, revert: CLEAN, ...over }).status;
	assert.equal(verdict({ baseline: new Map([["E01", "exit 1"]]) }), STATUS.INCONCLUSIVE);
	assert.equal(verdict({ revert: { clean: false, reapplies: false } }), STATUS.DIRTY);
	assert.equal(verdict({ revert: { clean: true, reapplies: false } }), STATUS.DIRTY);
	assert.equal(verdict({ run: { exitCode: 2, results: [] } }), STATUS.ERROR);
});

test("the run passes only with at least one kill and no failed row", () => {
	const rows = (...statuses) => statuses.map((status) => ({ status }));
	assert.equal(runExitCode(rows(STATUS.KILLED, STATUS.DEFERRED, STATUS.NO_B0)), 0);
	assert.equal(runExitCode(rows(STATUS.DEFERRED, STATUS.NO_B0)), 1);
	for (const bad of [
		STATUS.SURVIVED,
		STATUS.WRONG_FAILURE,
		STATUS.INCONCLUSIVE,
		STATUS.STALE,
		STATUS.DIRTY,
		STATUS.ERROR,
	])
		assert.equal(runExitCode(rows(STATUS.KILLED, bad)), 1, bad);
	assert.equal(runExitCode([]), 1);
});

test("the table escapes cell separators", () => {
	const table = renderTable([{ ...ROW, expect: { E01: /a|b/ }, status: STATUS.KILLED, note: "" }], "darwin-arm64");
	assert.match(table, /`a\\\|b`/);
	assert.equal(table.split("\n").length, 3);
});
