#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PLATFORM_JOBS } from "./ci-platform-scope.mjs";
import { resolveWorkspaceDirectories } from "./run-workspaces.mjs";

// Contract (senpi#6620): every workspace with a `test` script runs in exactly one hosted CI job, or is named below as
// not run there, and every job that runs a suite gates merges. Splitting the workspace suites into matrix groups made
// it easy to drop a workspace from every group (its suite would then silently stop running), to list one twice
// (running it twice per run, as senpi-codemode was), or to leave a suite's job out of the fan-in.
const WORKFLOW = ".github/workflows/ci.yml";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workflow = readFileSync(new URL(`../${WORKFLOW}`, import.meta.url), "utf8");

/** Workspaces with a `test` script that no hosted CI job runs today, each with the reason. */
const NOT_IN_HOSTED_CI = {
	"packages/chord": "no hosted job has run this suite; see senpi#6621",
	"packages/evals": "model-backed eval suites that spend tokens by design",
	"packages/session-backends/sqlite-bun": "no hosted job has run this suite; see senpi#6621",
	"packages/session-backends/sqlite-node": "no hosted job has run this suite; see senpi#6621",
};

/** The workflow's jobs as id -> YAML text, read from the text so no YAML parser is needed. */
function jobsOf(text) {
	const body = text.slice(text.search(/^jobs:\n/m));
	return new Map([...body.matchAll(/^  ([\w-]+):\n[\s\S]*?(?=^  [\w-]+:\n|$(?![\s\S]))/gm)].map((match) => [match[1], match[0]]));
}

/**
 * The commands that run a whole suite. Every step of every job is scanned, so a second run of a suite (in another
 * job, or in a second step of the same one) fails the one-owner contract instead of running the suite twice.
 * `bun run test:scripts` is not listed: it is the deliberate bun-launched twin of `npm run test:scripts`.
 */
const WHOLE_SUITE_COMMANDS = {
	"the workspace matrix": /\brun: node scripts\/run-workspaces\.mjs --if-present \$\{\{ matrix\.workspaces \}\} test\b/,
	"the coding-agent shards": /\bvitest run --shard=|\b(?:bun|npm|pnpm) run --cwd packages\/coding-agent test\b/,
	"the senpi-codemode suite": /\b(?:bun|npm|pnpm) run --cwd packages\/senpi-codemode test\b|working-directory: packages\/senpi-codemode\n[\s\S]*\brun: (?:bun|npm|pnpm) (?:run )?test\b|\brun: (?:bun|npm|pnpm) (?:run )?test\b[\s\S]*\n\s+working-directory: packages\/senpi-codemode\b/,
	"the scripts suite": /\brun: npm run test:scripts\b/,
};

/** The one job whose steps run `what`; a suite run by no step or by two would break the one-owner contract. */
function onlyJob(jobs, what) {
	const runs = [...jobs].flatMap(([id, block]) =>
		block.split(/\n {6}- /).slice(1).filter((step) => WHOLE_SUITE_COMMANDS[what].test(step)).map(() => id));
	assert.equal(runs.length, 1, `${what} must run in exactly one step of ${WORKFLOW}; found in: ${runs.join(", ") || "none"}`);
	return runs[0];
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
 * Which job runs each suite, derived from the commands in the workflow: workspace path -> owning job labels, plus
 * the set of job ids that run a suite (including the scripts suite, which belongs to no workspace).
 */
function suiteOwnership(text) {
	const jobs = jobsOf(text);
	const owners = new Map();
	const claim = (path, owner) => owners.set(path, [...(owners.get(path) ?? []), owner]);
	const matrix = onlyJob(jobs, "the workspace matrix");
	for (const { group, paths } of matrixGroups(jobs.get(matrix))) for (const path of paths) claim(path, `${matrix} (${group})`);
	const shards = onlyJob(jobs, "the coding-agent shards");
	claim("packages/coding-agent", shards);
	// `test/` is already in the package's own test script, so the extra filter selects nothing new: the whole suite runs.
	const codemode = onlyJob(jobs, "the senpi-codemode suite");
	claim("packages/senpi-codemode", codemode);
	const scripts = onlyJob(jobs, "the scripts suite");
	return { owners, suiteJobs: [matrix, shards, codemode, scripts] };
}

/** Suite jobs missing from the "Check and test" fan-in, whose failure would then not block a merge. */
function missingFromFanIn(text) {
	const needs = jobsOf(text).get("check-and-test")?.match(/\n {4}needs:\s*\[([^\]]*)\]/)?.[1];
	assert.ok(needs, "check-and-test must list its needs as a [...] list");
	const listed = needs.split(",").map((name) => name.trim()).filter(Boolean);
	return suiteOwnership(text).suiteJobs.filter((name) => !listed.includes(name));
}

test("every job that runs a suite is in the Check and test fan-in", () => {
	assert.deepEqual(missingFromFanIn(workflow), [], `add these jobs to check-and-test.needs in ${WORKFLOW}`);
});

test("the fan-in check follows the workflow's own suite jobs, whatever they are named", () => {
	// A renamed suite job that is also dropped from the fan-in must be reported under its new name.
	const renamed = workflow.replace(/^  codemode-tests:\n/m, "  codemode-suite:\n").replace(/^ {8}codemode-tests,\n/m, "");
	assert.deepEqual(missingFromFanIn(renamed), ["codemode-suite"]);
});

test("a suite run a second time anywhere in the workflow fails the runs-once check", () => {
	// The codemode package suite added back to codemode-gate would run it twice per CI run again.
	const twice = workflow.replace(
		/(\n {6}- name: Eval regression gate\n)/,
		"\n      - name: Codemode package tests again\n        run: bun run --cwd packages/senpi-codemode test\n$1",
	);
	assert.notEqual(twice, workflow);
	assert.throws(() => suiteOwnership(twice), /the senpi-codemode suite must run in exactly one step of .*found in: codemode-gate, codemode-tests/);
});

test("no suite job is a platform job the fan-in lets a non-full run skip", () => {
	// ci-platform-scope.mjs verify accepts `skipped` for PLATFORM_JOBS, so a suite there could silently not run.
	const skippable = suiteOwnership(workflow).suiteJobs.filter((name) => PLATFORM_JOBS.includes(name));
	assert.deepEqual(skippable, [], "suite jobs must not be in PLATFORM_JOBS in scripts/ci-platform-scope.mjs");
});

test("every workspace test script runs in exactly one CI job or is named as not run in hosted CI", async () => {
	const tested = (await resolveWorkspaceDirectories(root))
		.filter((workspace) => typeof workspace.scripts.test === "string")
		.map((workspace) => workspace.relativePath);
	const { owners } = suiteOwnership(workflow);
	for (const path of Object.keys(NOT_IN_HOSTED_CI)) owners.set(path, [...(owners.get(path) ?? []), "NOT_IN_HOSTED_CI"]);

	const unowned = tested.filter((path) => !owners.has(path));
	assert.deepEqual(unowned, [],
		`These workspaces have a test script that no CI job runs. Add each to a test-workspaces matrix group in ${WORKFLOW}, ` +
		`or to NOT_IN_HOSTED_CI in scripts/ci-workspace-coverage.test.mjs with the reason.`);
	const twice = [...owners].filter(([, list]) => list.length > 1).map(([path, list]) => `${path}: ${list.join(", ")}`);
	assert.deepEqual(twice, [], "a workspace suite must run once per CI run");
	// --if-present skips a workspace without a test script, so a stale entry would run nothing without failing.
	const stale = [...owners.keys()].filter((path) => !tested.includes(path));
	assert.deepEqual(stale, [], `listed workspaces with no test script; remove them from ${WORKFLOW} or this file`);
});
