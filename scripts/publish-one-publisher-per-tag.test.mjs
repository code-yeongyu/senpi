#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { cleanupFakes, fakeBin } from "./build-binaries-release-recovery.test-support.mjs";

// senpi#7469: one release tag got two publish-npm.yml publish-only runs (the preflight's printed hand dispatch and the
// tag's Build Binaries dispatch), and the loser's finalize deleted the draft GitHub Release on registry lag.
const workflow = readFileSync(new URL("../.github/workflows/publish-npm.yml", import.meta.url), "utf8");
const releaseScript = readFileSync(new URL("./release.mjs", import.meta.url), "utf8");

afterEach(cleanupFakes);

const releaseJob = workflow.match(/\n {2}release:\n[\s\S]*?(?=\n {2}[a-z-]+:\n)/)?.[0] ?? "";
const guardStep = releaseJob.match(/- name: Refuse a second publisher for the tag\n[\s\S]*?(?=\n {6}- name: )/)?.[0] ?? "";

/** Runs the guard's script with `gh run list` answering `listOutput`; returns the exit status and output. */
function runGuard(listOutput) {
	const script = guardStep.match(/run: \|\n([\s\S]*)/)?.[1].replace(/^ {10}/gm, "");
	assert.ok(script, "expected the guard's run script");
	const gh = fakeBin("gh", `echo "$*" >> "$LOG"\nprintf '%s' ${JSON.stringify(listOutput)}`);
	const result = spawnSync("bash", ["-c", script], {
		env: { PATH: `${gh.root}:${process.env.PATH}`, RELEASE_TAG: "v2026.11.25", GH_REPO: "code-yeongyu/senpi" },
		encoding: "utf8",
	});
	return { status: result.status, output: result.stdout + result.stderr, calls: gh.calls() };
}

describe("one publisher per release tag (senpi#7469)", () => {
	it("refuses a manual publish-only run before it checks out or publishes anything", () => {
		assert.ok(guardStep, "expected the release job to carry the 'Refuse a second publisher for the tag' step");
		assert.match(guardStep, /if: inputs\.publish-only == true && inputs\.build_run_id == '' && inputs\.dry_run != true/);
		const guardAt = releaseJob.indexOf("- name: Refuse a second publisher for the tag");
		for (const later of ["- name: Checkout", "- name: Publish prepared version"]) {
			assert.ok(releaseJob.indexOf(later) > guardAt, `the guard must run before '${later}'`);
		}
	});

	it("fails while a Build Binaries run for the tag is queued, running or has succeeded", () => {
		const refused = runGuard("45678439676");
		assert.equal(refused.status, 1, refused.output);
		assert.match(refused.output, /Build Binaries run\(s\) 45678439676 for v2026\.11\.25 publish this tag themselves/);
		assert.ok(refused.calls.some((call) => call.startsWith("run list --workflow build-binaries.yml --branch v2026.11.25")), refused.calls.join("\n"));
	});

	it("lets a manual publish-only run recover a tag whose Build Binaries run failed", () => {
		const allowed = runGuard("");
		assert.equal(allowed.status, 0, allowed.output);
	});

	it("names the version in the run title, which the draft cleanup reads to find a run that published it", () => {
		assert.match(workflow, /\nrun-name: Release \$\{\{ inputs\.version \|\| 'auto' \}\}/);
	});

	it("no longer tells the person cutting a release to dispatch publish-only by hand", () => {
		assert.doesNotMatch(releaseScript, /publish with: gh workflow run publish-npm\.yml/);
		assert.match(releaseScript, /the tag's Build Binaries run publishes it/);
	});
});
