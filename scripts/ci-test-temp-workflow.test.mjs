#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

test("every CI test-runtime invocation is between temp snapshot and always-run count (#3064)", () => {
	for (const [name, job] of Object.entries(parse(workflow).jobs)) {
		const steps = job.steps ?? [];
		const invocations = steps.flatMap((step, index) =>
			/(?:run-tests\.mjs|\bvitest\b|\bbun test\b|\bnode --test\b|\b(?:npm|bun) run (?:--cwd \S+ )?test(?::scripts)?(?:\s|$))/.test(step.run ?? "")
				? [index] : []);
		if (invocations.length === 0) continue;
		const snapshot = steps.findIndex((step) => step.run?.includes("test-temp-guard.mjs snapshot"));
		const check = steps.findIndex((step) => step.run?.includes("test-temp-guard.mjs check"));
		assert.ok(snapshot >= 0 && invocations.every((index) => index > snapshot && index < check), name);
		assert.match(steps[check].if, /always\(\)/, name);
		assert.match(steps[check].if, /test_temp_snapshot\.outcome == 'success'/, name);
	}
});

test("the real CLI recovery self-test owns temp storage and counts leftovers (#3064)", () => {
	const job = workflow.match(/^  check:\n[\s\S]*?(?=^  [\w-]+:)/m)?.[0];
	assert.ok(job, "missing static checks job");
	const snapshot = job.indexOf("scripts/test-temp-guard.mjs snapshot");
	const invocation = job.indexOf("scripts/run-tests.mjs node .agents/skills/senpi-qa/scripts/mock-loop.mjs");
	const check = job.indexOf("scripts/test-temp-guard.mjs check");
	assert.ok(snapshot >= 0 && invocation > snapshot && check > invocation,
		"the self-test must run between snapshot setup and final count");
	assert.match(job, /snapshot local-ignore\/test-temp-before\.json --export-env/);
	assert.match(job, /--self-test --api anthropic-messages/);
	assert.match(job, /if: always\(\) && steps\.test_temp_snapshot\.outcome == 'success'/);
	assert.match(job, /check local-ignore\/test-temp-before\.json/);
});
