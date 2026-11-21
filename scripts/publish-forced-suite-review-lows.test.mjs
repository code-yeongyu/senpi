#!/usr/bin/env node
// senpi#6645 review LOWs: the release concurrency group is per ref outside main (L2), prepare refuses a live dispatch
// off main before the matrix runs (L3), and every prepare output is read by a later job (L5).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { evaluateExpression, isTruthy, jobStep, workflowJob } from "./workflow-text.test-support.mjs";

const workflow = readFileSync(new URL("../.github/workflows/publish-npm.yml", import.meta.url), "utf8");
const REFUSAL = "Refuse a live release from any ref but main";
const MAIN = "refs/heads/main";
const BRANCH = "refs/heads/ci/6642-forced-suite-matrix";

/** The concurrency group a run on `ref` joins: the literal prefix plus the evaluated `${{ }}` part. */
function concurrencyGroup(text, ref) {
	const line = text.match(/\nconcurrency:\n {2}group: (.*)\n/)?.[1];
	assert.ok(line, "expected a workflow-level concurrency group");
	return line.replace(/\$\{\{ (.*?) \}\}/g, (_, source) => String(evaluateExpression(source, { github: { ref } })));
}

describe("release workflow after the senpi#6645 review", () => {
	it("keeps every main release in one group and gives each other ref its own group (L2)", () => {
		assert.equal(concurrencyGroup(workflow, MAIN), "release-main");
		assert.equal(concurrencyGroup(workflow, BRANCH), `release-${BRANCH}`);
		assert.notEqual(concurrencyGroup(workflow, "refs/heads/other"), concurrencyGroup(workflow, BRANCH));
		const shared = workflow.replace(/(\nconcurrency:\n {2}group: ).*\n/, "$1release\n");
		assert.equal(concurrencyGroup(shared, BRANCH), concurrencyGroup(shared, MAIN), "control: the old shared group");
	});

	it("runs the release job's own refusal as prepare's first step, so a live dispatch off main stops before the matrix (L3)", () => {
		const prepare = workflowJob(workflow, "prepare");
		const refusal = jobStep(prepare, REFUSAL);
		assert.equal(refusal, jobStep(workflowJob(workflow, "release"), REFUSAL), "prepare's refusal drifted from the release job's");
		assert.ok(prepare.indexOf(`- name: ${REFUSAL}`) < prepare.indexOf("- name: Checkout"));
		const stepIf = refusal.match(/\n {8}if: (.*)\n/)?.[1];
		assert.ok(stepIf);
		for (const ref of [MAIN, BRANCH]) {
			for (const dryRun of [false, true]) {
				const context = { github: { ref }, inputs: { dry_run: dryRun, force_tests: true, "publish-only": false } };
				assert.equal(isTruthy(evaluateExpression(stepIf, context)), ref === BRANCH && !dryRun, `${ref} dry_run=${dryRun}`);
			}
		}
	});

	it("declares only prepare outputs that a later job reads (L5)", () => {
		const outputs = workflowJob(workflow, "prepare").match(/\n {4}outputs:\n((?: {6}.*\n)+)/)?.[1];
		assert.ok(outputs, "expected prepare outputs");
		const names = [...outputs.matchAll(/^ {6}([\w-]+):/gm)].map((match) => match[1]);
		assert.ok(names.includes("tested_sha"));
		for (const name of names) assert.match(workflow, new RegExp(`needs\\.prepare\\.outputs\\.${name}\\b`), `prepare output ${name} is never read`);
	});
});
