#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveWorkspaceDirectories } from "./run-workspaces.mjs";

// Contract (senpi#6620): every workspace with a `test` script runs in exactly one hosted CI job, or is named below as
// not run there. Splitting the workspace suites into matrix groups made it easy to drop a workspace from every group
// (its suite would then silently stop running) or to list one twice (running it twice per run, as senpi-codemode was).
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

const jobBlock = (name) => {
	const block = workflow.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [\\w-]+:|$(?![\\s\\S]))`, "m"))?.[0];
	assert.ok(block, `${WORKFLOW} has no ${name} job`);
	return block;
};

/** Workspaces whose whole `test` script runs in a dedicated job instead of the test-workspaces matrix. */
function dedicatedJobs() {
	const shards = jobBlock("test-coding-agent");
	assert.match(shards, /run: node \.\.\/\.\.\/scripts\/run-tests\.mjs vitest run --shard=.*\n\s+working-directory: packages\/coding-agent\n/);
	// `test/` is already in the package's own test script, so the extra filter selects nothing new: the whole suite runs.
	assert.match(jobBlock("codemode-tests"), /\n\s+run: bun run --cwd packages\/senpi-codemode test -- test\/gate\n/);
	return { "packages/coding-agent": "test-coding-agent", "packages/senpi-codemode": "codemode-tests" };
}

function matrixGroups() {
	const job = jobBlock("test-workspaces");
	assert.match(job, /\n\s+run: node scripts\/run-workspaces\.mjs --if-present \$\{\{ matrix\.workspaces \}\} test\n/);
	const include = job.match(/\n {8}include:\n([\s\S]*?)\n {4}runs-on:/)?.[1];
	assert.ok(include, "test-workspaces must list its groups under strategy.matrix.include");
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

// The jobs that own a suite; each must gate merges through the "Check and test" fan-in, or its failure is ignored.
const SUITE_JOBS = ["test-workspaces", "test-coding-agent", "codemode-tests", "test-scripts"];

test("every job that owns a suite is in the Check and test fan-in", () => {
	const needs = jobBlock("check-and-test").match(/\n {4}needs:\s*\[([^\]]*)\]/)?.[1];
	assert.ok(needs, "check-and-test must list its needs as a [...] list");
	const listed = needs.split(",").map((name) => name.trim()).filter(Boolean);
	const missing = SUITE_JOBS.filter((name) => !listed.includes(name));
	assert.deepEqual(missing, [], `add these jobs to check-and-test.needs in ${WORKFLOW}`);
});

test("every workspace test script runs in exactly one CI job or is named as not run in hosted CI", async () => {
	const tested = (await resolveWorkspaceDirectories(root))
		.filter((workspace) => typeof workspace.scripts.test === "string")
		.map((workspace) => workspace.relativePath);
	const owners = new Map();
	const claim = (path, owner) => owners.set(path, [...(owners.get(path) ?? []), owner]);
	for (const { group, paths } of matrixGroups()) for (const path of paths) claim(path, `test-workspaces (${group})`);
	for (const [path, job] of Object.entries(dedicatedJobs())) claim(path, job);
	for (const path of Object.keys(NOT_IN_HOSTED_CI)) claim(path, "NOT_IN_HOSTED_CI");

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
