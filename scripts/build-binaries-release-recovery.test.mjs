#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { evaluateExpression } from "./workflow-text.test-support.mjs";

const { jobs } = parse(
	readFileSync(
		new URL("../.github/workflows/build-binaries.yml", import.meta.url),
		"utf8",
	),
);

const publishWorkflow = parse(readFileSync(new URL("../.github/workflows/publish-npm.yml", import.meta.url), "utf8"));
const FINALIZE = "node scripts/release-finalize.mjs";
const finalizeStep = (job) => {
	const step = job.steps.find((s) => s.run === FINALIZE);
	assert.ok(step, `no step runs ${FINALIZE}`);
	return step;
};
const bare = (expression) => expression.replace(/^\$\{\{\s*|\s*\}\}$/g, "");

describe("build-binaries.yml release recovery wiring (senpi#4173, senpi#6851)", () => {
	it("publish-npm only dispatches and finds the run: no step waits for it", () => {
		const job = jobs["publish-npm"];
		assert.ok(job["timeout-minutes"] <= 15, `publish-npm timeout ${job["timeout-minutes"]}`);
		assert.ok(job.steps.every((s) => !/gh run watch|await-dispatched-run|run view/.test(s.run ?? "")), "publish-npm still polls the publish run");
		const dispatch = job.steps.find((s) => s.id === "dispatch");
		assert.match(dispatch.run, /gh workflow run publish-npm\.yml -f version="\$\{VERSION\}" -f publish-only=true -f build_run_id="\$\{BUILD_RUN_ID\}"/);
		assert.equal(dispatch.env.BUILD_RUN_ID, "${{ github.run_id }}");
		assert.equal(publishWorkflow.on.workflow_dispatch.inputs.build_run_id.default, "");
	});

	it("publish-npm exposes the dispatched run id from its find step", () => {
		const job = jobs["publish-npm"];
		const match = /^\$\{\{\s*steps\.([\w-]+)\.outputs\.run_id\s*\}\}$/.exec(job.outputs?.run_id ?? "");
		assert.ok(match, `publish-npm outputs.run_id: ${job.outputs?.run_id}`);
		const find = job.steps.find((s) => s.id === match[1]);
		assert.match(find.run, /run_id=.*>>\s*"\$\{GITHUB_OUTPUT\}"/);
	});

	it("finalize-release runs after smoke and staging whenever a publish run was dispatched, even after a failure", () => {
		const job = jobs["finalize-release"];
		assert.deepEqual([...job.needs].sort(), ["build", "publish-npm", "smoke-test-binaries", "stage-github-release"]);
		assert.equal(bare(job.if), "always() && inputs.dry_run != true && needs.publish-npm.result != 'skipped'");
		const step = finalizeStep(job);
		assert.equal(step.env.BUILD_RUN_ID, "${{ github.run_id }}");
		assert.equal(step.env.PUBLISH_RUN_ID, "${{ needs.publish-npm.outputs.run_id }}");
		assert.equal(step.env.DISPATCH_RESULT, "${{ needs.publish-npm.result }}");
		assert.deepEqual(job.permissions, { actions: "read", contents: "write", issues: "write" });
	});

	it("the publish run's finalize-github-release runs after its release job, only for a Build Binaries publish-only run", () => {
		const job = publishWorkflow.jobs["finalize-github-release"];
		assert.equal(job.needs, "release");
		assert.equal(bare(job.if), "always() && inputs.publish-only == true && inputs.dry_run != true && inputs.build_run_id != ''");
		const step = finalizeStep(job);
		assert.equal(step.env.BUILD_RUN_ID, "${{ inputs.build_run_id }}");
		assert.equal(step.env.PUBLISH_RUN_ID, "${{ github.run_id }}");
		assert.equal(step.env.RELEASE_TAG, "v${{ inputs.version }}");
		assert.equal(step.env.DISPATCH_RESULT, undefined);
		// Job-level permissions replace the workflow's id-token: write; no publish token reaches this job.
		assert.deepEqual(job.permissions, { actions: "read", contents: "write", issues: "write" });
		assert.ok(!JSON.stringify(job).includes("UPSTREAM_AUTOMATION_TOKEN"));
	});

	it("both finalize jobs share one concurrency group per tag and never cancel each other", () => {
		const group = (job, context) => job.concurrency.group.replace(/\$\{\{ (.*?) \}\}/g, (_, expression) => evaluateExpression(expression, context));
		const tag = "v2026.11.16-1";
		const binaries = group(jobs["finalize-release"], { github: { event: { inputs: {} }, ref_name: tag } });
		const dispatched = group(jobs["finalize-release"], { github: { event: { inputs: { tag } }, ref_name: "main" } });
		const publish = group(publishWorkflow.jobs["finalize-github-release"], { inputs: { version: "2026.11.16-1" } });
		assert.equal(binaries, `release-finalize-${tag}`);
		assert.equal(dispatched, binaries);
		assert.equal(publish, binaries);
		for (const job of [jobs["finalize-release"], publishWorkflow.jobs["finalize-github-release"]]) assert.equal(job.concurrency["cancel-in-progress"], false);
	});

	it("only the finalize job publishes, reports or cleans up the GitHub Release", () => {
		for (const [name, job] of Object.entries(jobs)) {
			if (name === "finalize-release" || name === "stage-github-release") continue;
			assert.ok(!JSON.stringify(job).match(/gh release (edit|delete)|release-draft-cleanup|release-smoke-failure-issue/), name);
		}
	});
});
