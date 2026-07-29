#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/publish-npm.yml", import.meta.url), "utf8");
const codingAgentPackage = JSON.parse(
	readFileSync(new URL("../packages/coding-agent/package.json", import.meta.url), "utf8"),
);
const appServerQaRunner = readFileSync(
	new URL("../packages/coding-agent/scripts/qa-app-server/run-all.mjs", import.meta.url),
	"utf8",
);

describe("publish-only workflow", () => {
	it("reuses the release validation instead of rerunning the full suite", () => {
		const publishStep = workflow.match(/- name: Publish prepared version[\s\S]*?(?=\n      - name: Workflow summary)/)?.[0];
		assert.ok(publishStep, "expected publish-only step");
		assert.match(publishStep, /node scripts\/publish\.mjs/);
		assert.doesNotMatch(publishStep, /npm run check|npm test/);
	});

	it("keeps binary package scripts shell-executable", () => {
		assert.doesNotMatch(codingAgentPackage.scripts["copy-binary-assets"], /&&\s*&&/);
	});
});

describe("Goal continuation safety release gate", () => {
	it("requires the dedicated Darwin Seatbelt probe before every release", () => {
		assert.equal(
			codingAgentPackage.scripts["qa:goal-continuation-safety"],
			"node scripts/qa-app-server/goal-continuation-safety.mjs",
		);
		assert.equal(codingAgentPackage.scripts["qa:app-server"], "node scripts/qa-app-server/run-all.mjs");
		assert.doesNotMatch(appServerQaRunner, /goal-continuation-safety/);

		const goalSafetyJob = workflow.match(
			/^  goal-continuation-safety:\n[\s\S]*?(?=^  [a-z][\w-]*:\n|\Z)/m,
		)?.[0];
		assert.ok(goalSafetyJob, "expected dedicated Goal continuation safety workflow job");
		assert.match(goalSafetyJob, /runs-on: macos-latest/);
		assert.match(goalSafetyJob, /requires macOS Seatbelt/);
		assert.match(goalSafetyJob, /npm run qa:goal-continuation-safety --workspace=@code-yeongyu\/senpi/);
		assert.match(workflow, /^  release:\n    needs: goal-continuation-safety\n/m);
	});
});
