#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";

const { jobs } = parse(
	readFileSync(
		new URL("../.github/workflows/build-binaries.yml", import.meta.url),
		"utf8",
	),
);

function stepRunning(job, script) {
	const step = job.steps.find((s) => s.run?.includes(`bash ${script}`));
	assert.ok(step, `no step runs ${script}`);
	return step;
}

describe("build-binaries.yml release recovery wiring (senpi#4173)", () => {
	it("publish-npm awaits the dispatched run through the script, under the job timeout", () => {
		const job = jobs["publish-npm"];
		assert.equal(job["timeout-minutes"], 360);
		assert.ok(
			job.steps.every((s) => !s.run?.includes("gh run watch")),
			"publish-npm still uses gh run watch",
		);
		const step = stepRunning(job, "scripts/await-dispatched-run.sh");
		const ceiling = Number(step.env.AWAIT_MAX_SECONDS);
		assert.equal(ceiling, 19800);
		assert.ok(ceiling < job["timeout-minutes"] * 60);
	});

	it("publish-npm exposes the dispatched run id from a step that finishes before the await", () => {
		const job = jobs["publish-npm"];
		const match = /^\$\{\{\s*steps\.([\w-]+)\.outputs\.run_id\s*\}\}$/.exec(
			job.outputs?.run_id ?? "",
		);
		assert.ok(match, `publish-npm outputs.run_id: ${job.outputs?.run_id}`);
		const findIndex = job.steps.findIndex((s) => s.id === match[1]);
		const awaitIndex = job.steps.indexOf(
			stepRunning(job, "scripts/await-dispatched-run.sh"),
		);
		assert.ok(findIndex >= 0 && findIndex < awaitIndex);
		assert.match(job.steps[findIndex].run, /run_id=.*>>\s*"\$\{GITHUB_OUTPUT\}"/);
	});

	it("cleanup-draft-github-release passes the publish run to the cleanup script", () => {
		const job = jobs["cleanup-draft-github-release"];
		assert.ok(job.needs.includes("publish-npm"));
		assert.equal(job.permissions.actions, "read");
		const step = stepRunning(job, "scripts/release-draft-cleanup.sh");
		assert.match(
			step.env.PUBLISH_RUN_ID,
			/^\$\{\{\s*needs\.publish-npm\.outputs\.run_id\s*\}\}$/,
		);
		assert.match(
			step.env.PUBLISH_JOB_RESULT,
			/^\$\{\{\s*needs\.publish-npm\.result\s*\}\}$/,
		);
	});
});
