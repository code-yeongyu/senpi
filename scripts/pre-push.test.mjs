#!/usr/bin/env node
import assert from "node:assert/strict";
import { test } from "node:test";
import { stringify } from "yaml";
import { checkSteps } from "./pre-push.mjs";

function workflow(steps, job = {}, global = {}) {
	return stringify({
		env: { SHARED: "workflow", FLAG: "1" },
		jobs: {
			check: { defaults: { run: { shell: "bash" } }, env: { SHARED: "job" }, steps, ...job },
			test: { steps: [{ run: "npm test" }] },
		},
		...global,
	});
}

test("new check commands are picked up in CI order with their literal env and without CI-only steps (#7180)", () => {
	const source = workflow([
		{ uses: "actions/checkout@v7", id: "ci_only_checkout" },
		{ name: "First check", run: "npm run check", env: { NODE_OPTIONS: "--max-old-space-size=10240" } },
		{ id: "ci_only_summary", if: "always()", run: "echo ${{ job.status }}" },
		{ name: "Added check", run: "npm run lint", env: { SHARED: "step" } },
	]);
	assert.deepEqual(checkSteps(source), [
		{
			name: "First check",
			run: "npm run check",
			env: { SHARED: "job", FLAG: "1", NODE_OPTIONS: "--max-old-space-size=10240" },
		},
		{ name: "Added check", run: "npm run lint", env: { SHARED: "step", FLAG: "1" } },
	]);
});

test("a local step that cannot be reproduced fails closed and names the step", () => {
	for (const [fields, reason] of [
		[{ if: "always()" }, /"if"/],
		[{ shell: "pwsh" }, /bash shell/],
		[{ "working-directory": "packages/ai" }, /"working-directory"/],
		[{ "continue-on-error": true }, /"continue-on-error"/],
		[{ env: { NODE_OPTIONS: "${{ vars.NODE_OPTIONS }}" } }, /env "NODE_OPTIONS".*literal/],
		[{ run: "echo ${{ github.sha }}" }, /without GitHub Actions expressions/],
		[{ uses: "example/lint@v1" }, /"uses"/],
	]) {
		assert.throws(() => checkSteps(workflow([{ name: "Changed check", run: "npm run check", ...fields }])), {
			message: new RegExp(`step "Changed check".*${reason.source}`),
		});
	}
});

test("unsupported inherited execution context and a missing local check both fail closed", () => {
	const steps = [{ run: "npm run check" }];
	assert.throws(
		() => checkSteps(workflow(steps, { defaults: { run: { shell: "bash", "working-directory": "other" } } })),
		/check job defaults\.run uses "working-directory"/,
	);
	assert.throws(() => checkSteps(workflow(steps, { container: "node:24" })), /check job uses "container"/);
	assert.throws(() => checkSteps(workflow(steps, {}, { env: { VALUE: "${{ vars.VALUE }}" } })), /workflow env "VALUE"/);
	assert.throws(() => checkSteps(workflow([{ id: "ci_only_setup", run: "npm ci" }])), /no local check steps/);
	assert.throws(() => checkSteps("jobs: {}"), /no jobs\.check\.steps/);
});
