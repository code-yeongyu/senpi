#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/review-claims.yml", import.meta.url), "utf8");
const jobs = [...workflow.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|(?![\s\S]))/gm)].map((match) => ({
	id: match[1],
	body: match[2],
}));
const gate = jobs.find((job) => job.id === "gate");

describe("Review claim gate on review events", () => {
	it("is the only job that reports under the required check name", () => {
		const named = jobs.filter((job) => /^\s+name: Review claim gate$/m.test(job.body));
		assert.deepEqual(
			named.map((job) => job.id),
			["gate"],
		);
	});

	it("evaluates on review events, so a skipped run never replaces the gate's real result", () => {
		assert.ok(gate, "missing gate job");
		assert.match(workflow, /^  pull_request_review:\n\s+types: \[submitted\]/m);
		const condition = gate.body.match(/^\s+if: >-\n([\s\S]*?)\n\s+runs-on:/m)?.[1] ?? "";
		assert.match(condition, /github\.event_name == 'pull_request_target'/);
		assert.match(condition, /github\.event_name == 'pull_request_review'/);
	});

	it("still runs when release-claim is skipped, and reads the labels left after it", () => {
		assert.ok(gate, "missing gate job");
		assert.match(gate.body, /^\s+needs: release-claim$/m);
		assert.match(gate.body, /!cancelled\(\)/);
		assert.match(gate.body, /github\.paginate\(github\.rest\.issues\.listLabelsOnIssue/);
		assert.doesNotMatch(gate.body, /context\.payload\.pull_request\.labels/);
	});

	it("never cancels another gate run, since a cancelled run blocks the merge as a required result", () => {
		assert.ok(gate, "missing gate job");
		assert.doesNotMatch(gate.body, /^\s+concurrency:/m);
		assert.doesNotMatch(gate.body, /cancel-in-progress/);
	});
});
