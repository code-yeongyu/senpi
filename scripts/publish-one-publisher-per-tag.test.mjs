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

// `gh run list` answers raw --json rows (Build Binaries runs, publish-npm.yml runs) and applies the step's own --jq
// program with real jq, so the guard's selection predicates are what the tests exercise.
const GH_RUN_LIST = `echo "$*" >> "$LOG"
filter="" previous=""
for argument in "$@"; do [ "$previous" = --jq ] && filter="$argument"; previous="$argument"; done
case "$*" in
  *build-binaries.yml*) rows="$BB_ROWS" ;;
  *publish-npm.yml*) rows="$PUBLISH_ROWS" ;;
  *) exit 2 ;;
esac
jq -r "$filter" <<< "$rows"`;

/** Runs the guard's script against those rows; this run is 999. Returns the exit status and output. */
function runGuard({ build = [], publish = [] } = {}) {
	const script = guardStep.match(/run: \|\n([\s\S]*)/)?.[1].replace(/^ {10}/gm, "");
	assert.ok(script, "expected the guard's run script");
	const gh = fakeBin("gh", GH_RUN_LIST);
	const result = spawnSync("bash", ["-c", script], {
		env: {
			PATH: `${gh.root}:${process.env.PATH}`,
			RELEASE_TAG: "v2026.11.25",
			GH_REPO: "code-yeongyu/senpi",
			GITHUB_RUN_ID: "999",
			BB_ROWS: JSON.stringify(build),
			PUBLISH_ROWS: JSON.stringify(publish),
		},
		encoding: "utf8",
	});
	return { status: result.status, output: result.stdout + result.stderr, calls: gh.calls() };
}

const bb = (databaseId, status, conclusion, extra = {}) => ({
	databaseId, status, conclusion, headBranch: "v2026.11.25", displayTitle: "Build Binaries v2026.11.25", ...extra,
});
const pub = (databaseId, displayTitle, status, conclusion) => ({ databaseId, displayTitle, status, conclusion });

describe("one publisher per release tag (senpi#7469)", () => {
	it("refuses a manual publish-only run before it checks out or publishes anything", () => {
		assert.ok(guardStep, "expected the release job to carry the 'Refuse a second publisher for the tag' step");
		assert.match(guardStep, /if: inputs\.publish-only == true && inputs\.build_run_id == '' && inputs\.dry_run != true/);
		const guardAt = releaseJob.indexOf("- name: Refuse a second publisher for the tag");
		for (const later of ["- name: Checkout", "- name: Publish prepared version"]) {
			assert.ok(releaseJob.indexOf(later) > guardAt, `the guard must run before '${later}'`);
		}
	});

	it("fails while a Build Binaries run for the tag is still running", () => {
		const refused = runGuard({ build: [bb(45678439676, "in_progress", null), bb(1, "completed", "success", { headBranch: "v2026.11.24", displayTitle: "Build Binaries v2026.11.24" })] });
		assert.equal(refused.status, 1, refused.output);
		assert.match(refused.output, /Build Binaries run\(s\) 45678439676 for v2026\.11\.25 are still running/);
	});

	it("sees a dispatched Build Binaries recovery run, which runs on main, by the tag in its title", () => {
		const refused = runGuard({ build: [bb(7, "queued", null, { headBranch: "main" })] });
		assert.equal(refused.status, 1, refused.output);
		assert.match(refused.output, /Build Binaries run\(s\) 7 for v2026\.11\.25 are still running/);
	});

	it("fails while another publish-only run of the version is running or has published it, ignoring this run", () => {
		for (const other of [pub(5, "Release 2026.11.25 publish-only", "in_progress", null), pub(5, "Release 2026.11.25 publish-only", "completed", "success")]) {
			const refused = runGuard({ publish: [other, pub(999, "Release 2026.11.25 publish-only", "in_progress", null)] });
			assert.equal(refused.status, 1, refused.output);
			assert.match(refused.output, /publish-only run\(s\) 5 of 2026\.11\.25 are running or already published it/);
		}
	});

	it("does not count the stamp run, a dry run or another version as a publisher", () => {
		const allowed = runGuard({
			publish: [
				pub(11, "Release 2026.11.25", "completed", "success"),
				pub(12, "Release 2026.11.25 publish-only dry-run", "completed", "success"),
				pub(13, "Release 2026.11.24 publish-only", "completed", "success"),
				pub(999, "Release 2026.11.25 publish-only", "in_progress", null),
			],
		});
		assert.equal(allowed.status, 0, allowed.output);
	});

	it("when Build Binaries succeeded but its publish-only run failed, refuses and names the re-run of that run", () => {
		const refused = runGuard({
			build: [bb(45678439676, "completed", "success")],
			publish: [pub(45679166975, "Release 2026.11.25 publish-only", "completed", "failure"), pub(999, "Release 2026.11.25 publish-only", "in_progress", null)],
		});
		assert.equal(refused.status, 1, refused.output);
		assert.match(refused.output, /recover with 'gh run rerun 45679166975 --failed'/);
	});

	it("lets a manual publish-only run recover a tag whose Build Binaries run failed", () => {
		const allowed = runGuard({ build: [bb(45678439676, "completed", "failure")] });
		assert.equal(allowed.status, 0, allowed.output);
	});

	it("titles each run with the version and marks publish-only and dry runs, which the guard and the cleanup read", () => {
		assert.match(workflow, /\nrun-name: Release \$\{\{ inputs\.version \|\| 'auto' \}\}\$\{\{ inputs\.publish-only && ' publish-only' \|\| '' \}\}\$\{\{ inputs\.dry_run && ' dry-run' \|\| '' \}\}/);
		const buildBinaries = readFileSync(new URL("../.github/workflows/build-binaries.yml", import.meta.url), "utf8");
		assert.match(buildBinaries, /\nrun-name: Build Binaries \$\{\{ github\.event\.inputs\.tag \|\| github\.ref_name \}\}/);
	});

	it("no longer tells the person cutting a release to dispatch publish-only by hand", () => {
		assert.doesNotMatch(releaseScript, /publish with: gh workflow run publish-npm\.yml/);
		assert.match(releaseScript, /the tag's Build Binaries run publishes it/);
	});
});
