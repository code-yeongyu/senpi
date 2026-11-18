#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { configDefaults } from "vitest/config";
import { BaseSequencer } from "vitest/node";
import { parse } from "yaml";
import { measureShard, SHARD_BUDGET_SECONDS } from "./ci-shard-budget.mjs";

const workflow = parse(readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"));
const job = workflow.jobs["test-coding-agent"];
const indices = job.strategy.matrix.shard;
const command = job.steps.find((step) => step.name === "Test shard").run;
const count = Number(command.match(/--shard=\$\{\{ matrix\.shard \}\}\/(\d+)/)[1]);
const root = fileURLToPath(new URL("../packages/coding-agent/", import.meta.url));
const files = globSync(configDefaults.include, {
	cwd: root,
	exclude: [...configDefaults.exclude, "test/manual-qa/**"],
}).map((file) => ({ moduleId: join(root, file) }));

const shard = (index, input = files) =>
	new BaseSequencer({ config: { root, shard: { index, count } } }).shard(input);

// senpi#4131: exercise the real Vitest partition used by the workflow, without running the suites.
test("the CI matrix schedules every partition with the existing timeout", () => {
	assert.deepEqual(indices, Array.from({ length: count }, (_, index) => index + 1));
	assert.equal(job.name, `Test (coding-agent \${{ matrix.shard }}/${count})`);
	assert.equal(job["timeout-minutes"], 30);
	assert.equal(job.steps.find((step) => step.name === "Test shard")["timeout-minutes"], 25);
	assert.equal(workflow.jobs["check-and-test"].name, "Check and test");
	assert.ok(workflow.jobs["check-and-test"].needs.includes("test-coding-agent"));
});

// senpi#5855: four shards ran 15-25 min on hosted main, reaching the 25-minute step timeout with no failing test.
// Main run 41947601029 spent 4905 s in its four `Test shard` steps, the slowest 1.22x the mean. That ratio was
// measured at four shards and is an estimate for any other count; the per-shard budget step below is the
// measurement that holds the line on every run.
const MEASURED_SHARD_STEP_SECONDS = 4905;
const MEASURED_SLOWEST_TO_MEAN = 1.22;

test("the shard count keeps the measured suite inside the per-shard budget", () => {
	const slowest = (MEASURED_SHARD_STEP_SECONDS / count) * MEASURED_SLOWEST_TO_MEAN;
	assert.ok(slowest <= SHARD_BUDGET_SECONDS * 0.85, `${count} shards: slowest projected ${Math.round(slowest)} s`);
});

test("every shard measures its own run against the budget after its tests", () => {
	assert.equal(SHARD_BUDGET_SECONDS, 900);
	const names = job.steps.map((step) => step.name);
	const tests = names.indexOf("Test shard");
	// The clock starts right before the tests, so a slow apt mirror or download cannot spend the budget.
	assert.equal(names[tests - 1], "Start the shard budget clock");
	assert.match(job.steps[tests - 1].run, /SHARD_BUDGET_STARTED=\$\(date \+%s\)" >> "\$GITHUB_ENV"/);
	const budget = job.steps[tests + 1];
	assert.equal(budget.name, "Shard time budget");
	assert.equal(budget.if, undefined);
	assert.equal(budget.run, "node scripts/ci-shard-budget.mjs");
	assert.equal(budget.env.SHARD_LABEL, job.name);
});

test("the budget check fails a shard that ran as long as main's slowest four-way shard", () => {
	// Main run 41947601029: `Test (coding-agent 2/4)` job ran 1550 s.
	assert.deepEqual(measureShard({ startedAt: 1_000, now: 2_550 }), { elapsed: 1550, budgetSeconds: 900, over: true });
	assert.equal(measureShard({ startedAt: 1_000, now: 1_900 }).over, false);
	assert.throws(() => measureShard({ startedAt: Number.NaN, now: 1 }), /epoch second/);
	const ran = (startedAt) =>
		spawnSync(process.execPath, [fileURLToPath(new URL("./ci-shard-budget.mjs", import.meta.url))], {
			env: { ...process.env, SHARD_BUDGET_STARTED: String(startedAt), SHARD_LABEL: "Test (coding-agent 2/4)" },
			encoding: "utf8",
		});
	const over = ran(Math.floor(Date.now() / 1000) - 1550);
	assert.equal(over.status, 1);
	assert.match(over.stdout, /^::error::Test \(coding-agent 2\/4\) ran 155\d s, over its 900 s budget \(senpi#5855\)/);
	const under = ran(Math.floor(Date.now() / 1000) - 60);
	assert.equal(under.status, 0, under.stdout);
});

test("every discovered coding-agent test belongs to exactly one scheduled shard", async () => {
	assert.ok(files.length > 0);
	const shards = await Promise.all(indices.map((index) => shard(index)));
	const assigned = shards.flat().map((file) => file.moduleId);
	assert.equal(assigned.length, files.length);
	assert.equal(new Set(assigned).size, files.length);
	assert.deepEqual(assigned.sort(), files.map((file) => file.moduleId).sort());
	const sizes = shards.map((part) => part.length);
	assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
});

test("shard membership is deterministic regardless of discovery order", async () => {
	for (const index of indices) {
		assert.deepEqual(await shard(index), await shard(index, [...files].reverse()));
	}
});

// senpi#4131: dependency downloads must not consume a shard's entire job budget.
test("every CI apt step has a short budget and uses the shared installer", () => {
	const aptJobs = ["check", "test-coding-agent", "grep-native-contract", "test-workspaces", "test-scripts"];
	for (const name of aptJobs) {
		const step = workflow.jobs[name].steps.find((entry) => entry.name === "Install system dependencies");
		assert.equal(step["timeout-minutes"], 5, name);
		assert.equal(step.uses, "./.github/actions/install-ci-system-deps", name);
		assert.match(step.with.packages, /\bripgrep\b/, name);
	}
});
