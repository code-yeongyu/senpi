#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PLATFORM_JOBS } from "./ci-platform-scope.mjs";
import { createSuiteScanner, runTwice, withStep } from "./ci-workflow-suites.test-support.mjs";
import { resolveWorkspaceDirectories } from "./run-workspaces.mjs";

// Contract (senpi#6620, senpi#6631): every workspace with a `test` script runs in exactly one hosted CI step, or is
// named below as not run there, and every job that runs a suite gates merges. Splitting the workspace suites into
// matrix groups made it easy to drop a workspace from every group (its suite would then silently stop running), to
// run one twice (as senpi-codemode was), or to leave a suite's job out of the fan-in.
const WORKFLOW = ".github/workflows/ci.yml";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workflow = readFileSync(new URL(`../${WORKFLOW}`, import.meta.url), "utf8");
const workspaces = await resolveWorkspaceDirectories(root);
const tested = workspaces.filter((workspace) => typeof workspace.scripts.test === "string");

/** Workspaces with a `test` script that no hosted CI job runs today, each with the reason. */
const NOT_IN_HOSTED_CI = {
	"packages/chord": "no hosted job has run this suite; see senpi#6621",
	"packages/evals": "model-backed eval suites that spend tokens by design",
	"packages/session-backends/sqlite-bun": "no hosted job has run this suite; see senpi#6621",
	"packages/session-backends/sqlite-node": "no hosted job has run this suite; see senpi#6621",
};

/** Extra runs of a suite in another job, kept on purpose; each must still exist, so a stale entry fails. */
const EXTRA_RUNS = {
	"packages/pty": {
		"terminal-cross-os": "the cross-OS terminal suite runs the PTY tests on Windows too; its Linux leg repeats the matrix run",
		"macos-combined": "the PTY tests on macOS",
	},
};

const { suiteOwnership, missingFromFanIn } = createSuiteScanner({ workspaces, extraRuns: EXTRA_RUNS });

test("every job that runs a suite is in the Check and test fan-in", () => {
	assert.deepEqual(missingFromFanIn(workflow), [], `add these jobs to check-and-test.needs in ${WORKFLOW}`);
});

test("the fan-in check follows the workflow's own suite jobs, whatever they are named", () => {
	// A renamed suite job that is also dropped from the fan-in must be reported under its new name.
	const renamed = workflow.replace(/^  codemode-tests:\n/m, "  codemode-suite:\n").replace(/^ {8}codemode-tests,\n/m, "");
	assert.deepEqual(missingFromFanIn(renamed), ["codemode-suite"]);
});

test("a second run is caught in another job, the same job, a block scalar, and each package-manager shape listed", () => {
	const ai = "packages/ai: test-workspaces (ai), test-scripts";
	const cases = [
		// The codemode package suite added back to codemode-gate would run it twice per CI run again.
		["codemode-gate", "      - run: bun run --cwd packages/senpi-codemode test\n", "packages/senpi-codemode: codemode-gate, codemode-tests"],
		// A second step of the job that already owns the suite.
		["codemode-tests", "      - run: bun run --cwd packages/senpi-codemode test\n", "packages/senpi-codemode: codemode-tests, codemode-tests"],
		// The same command in a block scalar, on the line after `run: |`.
		["codemode-gate", "      - name: Again\n        run: |\n          echo start\n          bun run --cwd packages/senpi-codemode test\n", "packages/senpi-codemode: codemode-gate, codemode-tests"],
		// A matrix-owned workspace run again through each package-manager shape.
		["test-scripts", "      - run: bun run --cwd packages/ai test\n", ai],
		["test-scripts", "      - run: npm run test --workspace @earendil-works/pi-ai\n", ai],
		["test-scripts", "      - working-directory: packages/ai\n        run: npm test\n", ai],
		["test-scripts", "      - working-directory: packages/ai\n        run: bun run test\n", ai],
		["test-scripts", "      - run: npm test -w packages/ai\n", ai],
		["test-scripts", "      - run: npm run test -w @earendil-works/pi-ai\n", ai],
		["test-scripts", "      - run: pnpm --filter @earendil-works/pi-ai test\n", ai],
		["test-scripts", "      - run: bun --cwd packages/ai run test\n", ai],
		["test-scripts", "      - run: cd packages/ai && npm test\n", ai],
		["test-scripts", "      - run: npm run --cwd ./packages/ai test\n", ai],
		["test-scripts", "      - run: yarn workspace @earendil-works/pi-ai test\n", ai],
		["test-scripts", "      - run: (cd packages/ai && npm test)\n", ai],
		["test-scripts", "      - run: npm t -w packages/ai\n", ai],
	];
	const missed = cases.filter(([job, step, expected]) => !runTwice(suiteOwnership(withStep(workflow, job, step)).owners).includes(expected))
		.map(([job, step]) => `${job}: ${step.trim()}`);
	assert.deepEqual(missed, [], "these second runs were not reported");
	// `bun test <files>` is Bun's own runner on the files it names, not the package's `test` script.
	const bunRunner = withStep(workflow, "test-scripts", "      - working-directory: packages/ai\n        run: bun test test/stream.test.ts\n");
	assert.deepEqual(runTwice(suiteOwnership(bunRunner).owners), []);
});

test("a test command the parser cannot place fails the check instead of counting as no run", () => {
	for (const command of ["npm --loglevel warn test --workspace packages/ai", "cd crates/senpi-pty && npm test", "yarn workspace @earendil-works/not-a-package test"]) {
		const text = withStep(workflow, "test-scripts", `      - name: Probe\n        run: ${command}\n`);
		assert.throws(() => suiteOwnership(text), (error) => error.message.includes(
			`unrecognised test invocation in test-scripts/Probe: ${command.replace(/^cd \S+ && /, "")}; teach the parser or rewrite the step`), command);
	}
});

test("a package manager counts only where a command starts, not as another command's argument", () => {
	for (const command of ["echo npm test", "node scripts/foo.mjs --pm npm test", "FOO=1 echo npm run test"]) {
		const text = withStep(workflow, "test-scripts", `      - name: Probe\n        run: ${command}\n`);
		assert.deepEqual(runTwice(suiteOwnership(text).owners), [], command);
	}
});

test("no suite job is a platform job the fan-in lets a non-full run skip", () => {
	// ci-platform-scope.mjs verify accepts `skipped` for PLATFORM_JOBS, so a suite there could silently not run.
	const skippable = suiteOwnership(workflow).suiteJobs.filter((name) => PLATFORM_JOBS.includes(name));
	assert.deepEqual(skippable, [], "suite jobs must not be in PLATFORM_JOBS in scripts/ci-platform-scope.mjs");
});

test("every workspace test script runs in exactly one CI step or is named as not run in hosted CI", () => {
	const paths = tested.map((workspace) => workspace.relativePath);
	const { owners } = suiteOwnership(workflow);
	assert.equal(owners.get("scripts")?.length, 1, "the scripts suite must run in exactly one step");
	owners.delete("scripts");
	for (const path of Object.keys(NOT_IN_HOSTED_CI)) owners.set(path, [...(owners.get(path) ?? []), "NOT_IN_HOSTED_CI"]);

	const unowned = paths.filter((path) => !owners.has(path));
	assert.deepEqual(unowned, [],
		`These workspaces have a test script that no CI job runs. Add each to a test-workspaces matrix group in ${WORKFLOW}, ` +
		`or to NOT_IN_HOSTED_CI in scripts/ci-workspace-coverage.test.mjs with the reason.`);
	assert.deepEqual(runTwice(owners), [], "a workspace suite must run once per CI run");
	// --if-present skips a workspace without a test script, so a stale entry would run nothing without failing.
	const stale = [...owners.keys()].filter((path) => !paths.includes(path));
	assert.deepEqual(stale, [], `listed workspaces with no test script; remove them from ${WORKFLOW} or this file`);
});
