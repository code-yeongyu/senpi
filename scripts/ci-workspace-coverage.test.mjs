#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PLATFORM_JOBS } from "./ci-platform-scope.mjs";
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

/** The workflow's jobs as id -> YAML text, read from the text so no YAML parser is needed. */
function jobsOf(text) {
	const body = text.slice(text.search(/^jobs:\n/m));
	return new Map([...body.matchAll(/^  ([\w-]+):\n[\s\S]*?(?=^  [\w-]+:\n|$(?![\s\S]))/gm)].map((match) => [match[1], match[0]]));
}

/** One job's steps as { run, cwd }; a block-scalar `run: |` or `run: >` is read whole and joined into one line. */
function stepsOf(block) {
	return block.split(/\n {6}- /).slice(1).map((dashed) => {
		// The first key sits on the `- ` line; indent it like the step's other keys.
		const step = `        ${dashed}`;
		const lines = step.split("\n");
		const at = lines.findIndex((line) => /^ {8}run: /.test(line));
		let run = "";
		if (at !== -1) {
			const value = lines[at].replace(/^ {8}run: /, "");
			const body = [];
			if (/^[|>][-+]?\s*$/.test(value)) {
				for (const line of lines.slice(at + 1)) {
					if (line.trim() && !/^ {9}/.test(line)) break;
					body.push(line);
				}
			} else body.push(value);
			run = body.join(" ").replace(/\\\s/g, " ").replace(/\s+/g, " ").trim();
		}
		return { run, cwd: step.match(/^ {8}working-directory: (\S+)/m)?.[1] };
	});
}

const byName = new Map(workspaces.flatMap((workspace) => [[workspace.name, workspace.relativePath], [workspace.relativePath, workspace.relativePath]]));
const SCRIPT = /(?<![\w:-])test(?![\w:-])/;

/** The suites one step runs in full: workspace paths, "scripts", or "matrix" for the run-workspaces matrix command. */
function suitesRunBy({ run, cwd }) {
	const suites = [];
	const runner = run.match(/run-workspaces\.mjs ((?:\S+ )*?)test(?![\w:-])/);
	if (runner) {
		if (runner[1].includes("${{ matrix.workspaces }}")) suites.push("matrix");
		const listed = [...runner[1].matchAll(/--workspace[= ](\S+)/g)].map((match) => byName.get(match[1]) ?? match[1]);
		suites.push(...(listed.length > 0 || runner[1].includes("matrix") ? listed : tested.map((workspace) => workspace.relativePath)));
	}
	for (const match of run.matchAll(/\b(?:npm|pnpm|bun) run --cwd (\S+) test(?![\w:-])/g)) suites.push(match[1]);
	for (const match of run.matchAll(/\b(?:npm|pnpm) (?:run )?test(?![\w:-])((?: --?[\w-]+(?:[= ](?!-)\S+)?)*)/g)) {
		const named = match[1].match(/--workspace[= ](\S+)/)?.[1];
		suites.push(named ? (byName.get(named) ?? named) : (cwd ?? "root"));
	}
	if (cwd === "packages/coding-agent" && /\bvitest run --shard=/.test(run)) suites.push("packages/coding-agent");
	if (/\bnpm run test:scripts(?![\w:-])/.test(run)) suites.push("scripts");
	return suites.filter((suite) => suite !== "root" || SCRIPT.test(run));
}

function matrixGroups(block) {
	const include = block.match(/\n {8}include:\n([\s\S]*?)\n {4}runs-on:/)?.[1];
	assert.ok(include, "the workspace matrix job must list its groups under strategy.matrix.include");
	return include.split(/\n {10}- /).filter((entry) => entry.trim()).map((entry) => {
		const group = entry.match(/group: (.+)/)?.[1];
		const value = entry.slice(entry.indexOf("workspaces:") + "workspaces:".length).replace(/^ >-/, "").trim();
		const tokens = value.split(/\s+/);
		assert.ok(group && tokens.length % 2 === 0, `unreadable matrix entry: ${entry}`);
		const paths = [];
		for (let index = 0; index < tokens.length; index += 2) {
			assert.equal(tokens[index], "--workspace", `group "${group}": ${value}`);
			paths.push(tokens[index + 1]);
		}
		return { group, paths };
	});
}

/**
 * Every step of every job, scanned for the suites it runs in full: suite -> one label per run (a suite run twice in
 * the same job is listed twice), with the EXTRA_RUNS taken out, plus the ids of the jobs that own those runs.
 */
function suiteOwnership(text) {
	const owners = new Map();
	const claim = (suite, label) => owners.set(suite, [...(owners.get(suite) ?? []), label]);
	for (const [id, block] of jobsOf(text)) {
		for (const step of stepsOf(block)) {
			for (const suite of suitesRunBy(step)) {
				if (suite !== "matrix") claim(suite, id);
				else for (const { group, paths } of matrixGroups(block)) for (const path of paths) claim(path, `${id} (${group})`);
			}
		}
	}
	for (const [suite, jobs] of Object.entries(EXTRA_RUNS)) {
		for (const job of Object.keys(jobs)) {
			const list = owners.get(suite) ?? [];
			assert.ok(list.includes(job), `EXTRA_RUNS lists ${job} for ${suite}, but that job no longer runs it`);
			list.splice(list.indexOf(job), 1);
		}
	}
	const suiteJobs = [...new Set([...owners.values()].flat().map((label) => label.replace(/ \(.*\)$/, "")))];
	return { owners, suiteJobs };
}

/** Suites run more than once per CI run, as "suite: owner, owner". */
const runTwice = (owners) => [...owners].filter(([, list]) => list.length > 1).map(([suite, list]) => `${suite}: ${list.join(", ")}`);

/** Suite jobs missing from the "Check and test" fan-in, whose failure would then not block a merge. */
function missingFromFanIn(text) {
	const needs = jobsOf(text).get("check-and-test")?.match(/\n {4}needs:\s*\[([^\]]*)\]/)?.[1];
	assert.ok(needs, "check-and-test must list its needs as a [...] list");
	const listed = needs.split(",").map((name) => name.trim()).filter(Boolean);
	return suiteOwnership(text).suiteJobs.filter((name) => !listed.includes(name));
}

/** The workflow with `step` inserted as the first step of job `id`. */
function withStep(text, id, step) {
	const block = jobsOf(text).get(id);
	assert.ok(block, `${WORKFLOW} has no ${id} job`);
	const steps = block.indexOf("\n    steps:\n") + "\n    steps:\n".length;
	return text.replace(block, block.slice(0, steps) + step + block.slice(steps));
}

test("every job that runs a suite is in the Check and test fan-in", () => {
	assert.deepEqual(missingFromFanIn(workflow), [], `add these jobs to check-and-test.needs in ${WORKFLOW}`);
});

test("the fan-in check follows the workflow's own suite jobs, whatever they are named", () => {
	// A renamed suite job that is also dropped from the fan-in must be reported under its new name.
	const renamed = workflow.replace(/^  codemode-tests:\n/m, "  codemode-suite:\n").replace(/^ {8}codemode-tests,\n/m, "");
	assert.deepEqual(missingFromFanIn(renamed), ["codemode-suite"]);
});

test("a suite run a second time is caught in another job, the same job, a block scalar, or another command shape", () => {
	const cases = [
		// The codemode package suite added back to codemode-gate would run it twice per CI run again.
		[withStep(workflow, "codemode-gate", "      - run: bun run --cwd packages/senpi-codemode test\n"), "packages/senpi-codemode: codemode-gate, codemode-tests"],
		// A second step of the job that already owns the suite.
		[withStep(workflow, "codemode-tests", "      - run: bun run --cwd packages/senpi-codemode test\n"), "packages/senpi-codemode: codemode-tests, codemode-tests"],
		// The same command in a block scalar, on the line after `run: |`.
		[withStep(workflow, "codemode-gate", "      - name: Again\n        run: |\n          echo start\n          bun run --cwd packages/senpi-codemode test\n"), "packages/senpi-codemode: codemode-gate, codemode-tests"],
		// A matrix-owned workspace run again through another command shape.
		[withStep(workflow, "test-scripts", "      - run: bun run --cwd packages/ai test\n"), "packages/ai: test-workspaces (ai), test-scripts"],
		[withStep(workflow, "test-scripts", "      - run: npm run test --workspace @earendil-works/pi-ai\n"), "packages/ai: test-workspaces (ai), test-scripts"],
		[withStep(workflow, "test-scripts", "      - working-directory: packages/ai\n        run: npm test\n"), "packages/ai: test-workspaces (ai), test-scripts"],
	];
	for (const [text, expected] of cases) {
		assert.notEqual(text, workflow);
		assert.ok(runTwice(suiteOwnership(text).owners).includes(expected), `${expected} not reported: ${runTwice(suiteOwnership(text).owners)}`);
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
