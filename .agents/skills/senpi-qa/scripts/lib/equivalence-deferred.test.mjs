// Deferred golden cells: the shipped list stays accountable (owner + issue + due, no stale entry), a DEFERRED cell is
// never a PASS and never a failure, and every other missing golden or stale entry fails the run.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { cases } from "../../scenarios/fused-equivalence/cases/index.mjs";
import { deferredGoldens } from "../../scenarios/fused-equivalence/deferred-goldens.mjs";
import {
	deferredGoldenPath,
	goldenCellVerdict,
	staleDeferredEntries,
	summarizeRun,
	validateDeferredList,
} from "./equivalence-deferred.mjs";

const CASE_IDS = cases.map((c) => c.id);

function withEnv(patch, body) {
	const saved = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]));
	const apply = (values) => {
		for (const [key, value] of Object.entries(values)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
	apply(patch);
	try {
		return body();
	} finally {
		apply(saved);
	}
}
const ENTRY = Object.freeze({
	platform: "linux-x64",
	case: "E25",
	mode: "rpc",
	owner: "brain-hand-exec-p0",
	issue: "https://github.com/code-yeongyu/senpi/issues/4827",
	due: "before PGATE-P0",
});

function withGoldenRoot(goldens, body) {
	const root = mkdtempSync(join(tmpdir(), "eq-deferred-"));
	try {
		for (const cell of goldens) {
			const file = deferredGoldenPath(cell, root);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, "{}\n");
		}
		return body(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("every shipped entry has an owner, an issue link and a due gate, and none has a golden yet", () => {
	assert.ok(deferredGoldens.length > 0);
	for (const entry of deferredGoldens) {
		assert.ok(entry.owner?.trim(), `${entry.case} ${entry.mode}: owner`);
		assert.match(
			entry.issue,
			/^https:\/\/github\.com\/.+\/(issues|pull)\/\d+$/,
			`${entry.case} ${entry.mode}: issue`,
		);
		assert.ok(entry.due?.trim(), `${entry.case} ${entry.mode}: due`);
	}
	assert.deepEqual(validateDeferredList(deferredGoldens, CASE_IDS), []);
	assert.deepEqual(staleDeferredEntries(deferredGoldens), [], "a listed cell has a golden: remove its entry");
});

test("an entry without an owner, an issue, a due gate or a known cell is rejected", () => {
	for (const [patch, problem] of [
		[{ owner: undefined }, /owner is required/],
		[{ owner: " " }, /owner is required/],
		[{ issue: undefined }, /issue must be/],
		[{ issue: "#4827" }, /issue must be/],
		[{ due: "" }, /due is required/],
		[{ case: "E99" }, /unknown case/],
		[{ mode: "headless" }, /mode must be/],
		[{ platform: "linux" }, /platform must be/],
	]) {
		const problems = validateDeferredList([{ ...ENTRY, ...patch }], CASE_IDS);
		assert.equal(problems.length, 1, JSON.stringify(patch));
		assert.match(problems[0], problem);
	}
	assert.match(validateDeferredList([ENTRY, { ...ENTRY }], CASE_IDS)[0], /duplicate cell/);
});

test("a listed cell whose golden exists is stale and fails the run", () => {
	withGoldenRoot([ENTRY], (root) => {
		assert.deepEqual(staleDeferredEntries([ENTRY], root), [ENTRY]);
		assert.deepEqual(goldenCellVerdict([ENTRY], ENTRY, root), { kind: "compare" });
		const passing = [{ id: "E25", pass: true }];
		assert.equal(summarizeRun(passing, [ENTRY], "compare").exitCode, 1);
		assert.match(summarizeRun(passing, [ENTRY], "compare").line, /1\/1 passed, 0 deferred, 1 failed/);
	});
});

test("a SKIPPED case is never PASS, is counted on its own, and does not fail the run (senpi#4964)", () => {
	const results = [
		{ id: "E29", pass: false, skipped: "no gondolin image store" },
		{ id: "E27", pass: true },
	];
	assert.deepEqual(summarizeRun(results, [], "compare"), {
		line: "fused-equivalence-qa compare: 1/2 passed, 0 deferred, 0 failed, 1 skipped",
		exitCode: 0,
	});
	const withFailure = [...results, { id: "E26", pass: false }];
	assert.equal(summarizeRun(withFailure, [], "compare").exitCode, 1);
});

test("E29 is skipped only on a hosted runner without a gondolin image store; elsewhere a missing store fails (senpi#4964)", () => {
	const e29 = cases.find((c) => c.id === "E29");
	assert.ok(e29);
	withEnv({ GITHUB_ACTIONS: "true", EQ_GONDOLIN_IMAGE_STORE: undefined }, () => {
		assert.match(String(e29.skip()), /^no gondolin image store/);
	});
	withEnv({ GITHUB_ACTIONS: undefined, CI: "1", EQ_GONDOLIN_IMAGE_STORE: undefined }, () => {
		assert.equal(e29.skip(), undefined);
		assert.throws(() => e29.spec(), /E29 needs EQ_GONDOLIN_IMAGE_STORE/);
	});
	withEnv({ GITHUB_ACTIONS: "true", EQ_GONDOLIN_IMAGE_STORE: "/images" }, () => {
		assert.equal(e29.skip(), undefined);
		assert.equal(e29.spec().env.GONDOLIN_IMAGE_STORE, "/images");
	});
});

test("a missing golden that is not listed fails; a listed one is DEFERRED, never PASS, and does not fail", () => {
	withGoldenRoot([], (root) => {
		const unlisted = { ...ENTRY, case: "E26" };
		assert.deepEqual(goldenCellVerdict([ENTRY], unlisted, root), { kind: "missing" });
		assert.deepEqual(goldenCellVerdict([ENTRY], { ...ENTRY, mode: "tui" }, root), { kind: "missing" });
		const deferred = goldenCellVerdict([ENTRY], ENTRY, root);
		assert.equal(deferred.kind, "deferred");
		assert.equal(deferred.label, `DEFERRED(${ENTRY.owner}, ${ENTRY.issue})`);

		const results = [
			{ id: "E25", pass: false, deferred: { owner: ENTRY.owner, issue: ENTRY.issue, due: ENTRY.due } },
			{ id: "E27", pass: true },
		];
		assert.deepEqual(summarizeRun(results, [], "compare"), {
			line: "fused-equivalence-qa compare: 1/2 passed, 1 deferred, 0 failed",
			exitCode: 0,
		});
		const withMissing = [...results, { id: "E26", pass: false }];
		assert.deepEqual(summarizeRun(withMissing, [], "compare"), {
			line: "fused-equivalence-qa compare: 1/3 passed, 1 deferred, 1 failed",
			exitCode: 1,
		});
	});
});
