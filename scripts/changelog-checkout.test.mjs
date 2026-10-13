#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { it } from "node:test";

it("audits the PR head rather than a synthetic merge with newer base changes", () => {
	const workflow = readFileSync(new URL("../.github/workflows/changelog-gate.yml", import.meta.url), "utf8");
	const checkoutInputs = workflow.match(/uses: actions\/checkout@[^\n]+\n\s+with:\n((?: {10}[^\n]+\n)+)/)?.[1];
	assert.ok(checkoutInputs, "checkout inputs are required");
	// On a pull request the head SHA is always set, so it wins; `github.sha` is only the merge queue's
	// commit, where there is no pull request (merge-queue-workflows.test.mjs).
	assert.match(checkoutInputs, /^\s+ref: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}\s*$/m);
});
