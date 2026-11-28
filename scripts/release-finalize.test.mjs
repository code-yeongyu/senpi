#!/usr/bin/env node
// senpi#6851: Build Binaries no longer holds a runner while npm publishes. Each half of the release (the binary smoke +
// staging, and the publish-only npm run) runs scripts/release-finalize.mjs when it is done, and the script acts only
// once both are. Release contract: the GitHub Release is published only after both staging and npm succeeded, a smoke
// failure after npm opens the rollback issue, a failed half runs the draft cleanup, and a second finalize repeats nothing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanupFakes, fakeBin } from "./build-binaries-release-recovery.test-support.mjs";
import { finalizeDecision, npmState, stageState } from "./release-finalize.mjs";

afterEach(cleanupFakes);

const script = fileURLToPath(new URL("./release-finalize.mjs", import.meta.url));
const job = (name, status, conclusion = null) => ({ name, status, conclusion, run_attempt: 1 });

describe("release-finalize.mjs: reading both halves (senpi#6851)", () => {
	it("reads staging as pending until its job completed, and as skipped when the run ended without it", () => {
		assert.equal(stageState([], "in_progress"), "pending");
		assert.equal(stageState([job("stage-github-release", "queued")], "in_progress"), "pending");
		assert.equal(stageState([job("stage-github-release", "completed", "failure")], ""), "failure");
		assert.equal(stageState([job("build", "completed", "failure")], "completed"), "skipped");
	});

	it("reads npm from the publish run's release job, the only publisher", () => {
		const read = (jobs, runStatus, extra = {}) => npmState({ dispatchResult: "", publishRunId: "9", jobs, runStatus, ...extra });
		assert.equal(read([job("release", "completed", "success")], ""), "success");
		// The run is still in progress while its own finalize job runs; the release job's result decides.
		assert.equal(read([job("release", "completed", "failure")], "in_progress"), "failure");
		assert.equal(read([job("release", "completed", "skipped")], ""), "failure");
		assert.equal(read([job("native-prebuilds / Plan native prebuilds", "in_progress")], "in_progress"), "pending");
		assert.equal(read([], "completed"), "failure", "a finished run whose release job never ran did not publish");
		assert.equal(read([], "", { dispatchResult: "failure" }), "failure", "a failed dispatch publishes nothing");
		assert.equal(read([], "", { publishRunId: "" }), "failure");
	});

	it("acts only when both halves are done, exactly as the old jobs did", () => {
		const table = [
			// npm,      stage,       smoke failed, action,     exit
			["pending", "success", false, "wait", 0],
			["success", "pending", false, "wait", 0],
			["pending", "pending", false, "wait", 0],
			["success", "success", false, "publish", 0],
			["success", "skipped", true, "report", 1],
			["success", "failure", false, "cleanup", 1],
			["success", "cancelled", false, "cleanup", 1],
			["success", "skipped", false, "none", 1],
			["failure", "success", false, "cleanup", 1],
			["failure", "failure", false, "cleanup", 1],
			["failure", "skipped", true, "none", 1],
		];
		for (const [npm, stage, smokeFailed, action, exit] of table) {
			assert.deepEqual(finalizeDecision({ npm, stage, smokeFailed }), { action, exit }, `${npm} / ${stage} / smoke failed ${smokeFailed}`);
		}
	});
});

describe("release-finalize.mjs: the script (senpi#6851)", () => {
	const BUILD_OK = [
		job("build", "completed", "success"),
		job("smoke-test-binaries (ubuntu-latest)", "completed", "success"),
		job("smoke-test-binaries (macos-latest)", "completed", "success"),
		job("smoke-test-binaries (windows-latest)", "completed", "success"),
		job("stage-github-release", "completed", "success"),
	];

	/** Runs the script on fake gh/npm; build run 11, publish run 22, tag v2026.11.16-1. */
	function finalize({ buildJobs = BUILD_OK, buildStatus = "in_progress", publishJobs = [], publishStatus = "in_progress", isDraft = "true", existingTitle = "", npmHas = false, env = {} }) {
		const gh = fakeBin(
			"gh",
			`echo "$*" >> "$LOG"
case "$*" in
  "api --paginate --slurp repos/o/r/actions/runs/11/jobs") cat "$DIR/build.json" ;;
  "api --paginate --slurp repos/o/r/actions/runs/22/jobs") cat "$DIR/publish.json" ;;
  "api repos/o/r/actions/runs/11 --jq .status") echo "$BUILD_STATUS" ;;
  "api repos/o/r/actions/runs/22 --jq .status") echo "$PUBLISH_STATUS" ;;
  "api --paginate --slurp repos/o/r/actions/runs/11/attempts/1/jobs") cat "$DIR/build.json" ;;
  "release view"*) echo "$IS_DRAFT" ;;
  "release edit"*|"release delete"*) exit 0 ;;
  "issue list"*) echo "$EXISTING_TITLE" ;;
  "issue create"*) echo https://github.com/o/r/issues/7 ;;
  "run view"*) echo "$PUBLISH_STATUS " ;;
  "run list"*displayTitle*) echo "" ;;
  "run list"*) echo 0 ;;
  *) echo "unexpected gh $*" >&2; exit 2 ;;
esac`,
		);
		const npm = fakeBin(
			"npm",
			`echo "$*" >> "$LOG"
case "$*" in
  *" time --json") echo '{"2026.11.15-2":"2026-11-15T00:00:00Z","2026.11.16-1":"2026-11-16T00:00:00Z"}' ;;
  *) if [ "$NPM_HAS" = true ]; then echo 2026.11.16-1; else echo "npm error code E404" >&2; exit 1; fi ;;
esac`,
		);
		writeFileSync(join(gh.root, "build.json"), JSON.stringify([{ jobs: buildJobs }]));
		writeFileSync(join(gh.root, "publish.json"), JSON.stringify([{ jobs: publishJobs }]));
		const result = spawnSync(process.execPath, [script], {
			encoding: "utf8",
			env: {
				PATH: `${gh.root}:${npm.root}:${process.env.PATH}`,
				DIR: gh.root,
				BUILD_STATUS: buildStatus,
				PUBLISH_STATUS: publishStatus,
				IS_DRAFT: isDraft,
				EXISTING_TITLE: existingTitle,
				NPM_HAS: String(npmHas),
				RELEASE_TAG: "v2026.11.16-1",
				GH_REPO: "o/r",
				BUILD_RUN_ID: "11",
				PUBLISH_RUN_ID: "22",
				...env,
			},
		});
		const calls = gh.calls();
		return { result, output: result.stdout + result.stderr, calls, did: (prefix) => calls.filter((call) => call.startsWith(prefix)) };
	}

	it("Build Binaries side, npm still publishing: does nothing and stays green, leaving it to the publish run", () => {
		const run = finalize({ publishJobs: [job("release", "in_progress")], env: { DISPATCH_RESULT: "success" } });
		assert.equal(run.result.status, 0, run.output);
		assert.match(run.output, /-> wait/);
		assert.deepEqual([...run.did("release"), ...run.did("issue")], []);
	});

	it("publish side, staging not done yet: does nothing, leaving it to Build Binaries", () => {
		const run = finalize({ buildJobs: [job("build", "completed", "success"), job("smoke-test-binaries (macos-latest)", "queued")], publishJobs: [job("release", "completed", "success")] });
		assert.equal(run.result.status, 0, run.output);
		assert.deepEqual(run.did("release"), []);
	});

	it("both halves succeeded: publishes the draft", () => {
		const run = finalize({ publishJobs: [job("release", "completed", "success")] });
		assert.equal(run.result.status, 0, run.output);
		assert.deepEqual(run.did("release edit"), ["release edit v2026.11.16-1 --draft=false"]);
	});

	it("a second finalize after the release went public repeats nothing", () => {
		const run = finalize({ publishJobs: [job("release", "completed", "success")], isDraft: "false" });
		assert.equal(run.result.status, 0, run.output);
		assert.deepEqual(run.did("release edit"), []);
	});

	it("smoke failed after npm published: opens the rollback issue once and fails", () => {
		const failed = [...BUILD_OK.slice(0, 2), job("smoke-test-binaries (macos-latest)", "completed", "failure"), BUILD_OK[3], job("stage-github-release", "completed", "skipped")];
		const run = finalize({ buildJobs: failed, publishJobs: [job("release", "completed", "success")] });
		assert.equal(run.result.status, 1, run.output);
		assert.equal(run.did("issue create").length, 1);
		assert.deepEqual(run.did("release"), []);
		const title = "Release 2026.11.16-1: standalone-binary smoke failed on macos-latest after npm published it";
		const again = finalize({ buildJobs: failed, publishJobs: [job("release", "completed", "success")], existingTitle: title });
		assert.equal(again.result.status, 1, again.output);
		assert.deepEqual(again.did("issue create"), []);
	});

	it("npm failed while its run still finalizes: deletes the draft npm does not have", () => {
		const run = finalize({ publishJobs: [job("release", "completed", "failure")], publishStatus: "in_progress" });
		assert.equal(run.result.status, 1, run.output);
		assert.deepEqual(run.did("release delete"), ["release delete v2026.11.16-1 --yes"]);
	});

	it("staging failed after npm published: keeps the draft npm already has and fails", () => {
		const buildJobs = [...BUILD_OK.slice(0, 4), job("stage-github-release", "completed", "failure")];
		const run = finalize({ buildJobs, publishJobs: [job("release", "completed", "success")], npmHas: true });
		assert.equal(run.result.status, 1, run.output);
		assert.deepEqual([...run.did("release delete"), ...run.did("release edit")], []);
		assert.match(run.output, /npm already has/);
	});

	it("Build Binaries side, the dispatch failed: runs the cleanup at once", () => {
		const run = finalize({ env: { DISPATCH_RESULT: "failure", PUBLISH_RUN_ID: "" } });
		assert.equal(run.result.status, 1, run.output);
		assert.ok(!run.calls.some((call) => call.includes("runs/22")), "no publish run to read");
		// Two queries before deleting: no dispatch still in flight, and (senpi#7469) no publish-only run of the version
		// succeeded, which matters exactly here, where the run id is unknown.
		const lists = run.did("run list");
		assert.equal(lists.length, 2, run.calls.join("\n"));
		assert.ok(lists.some((call) => call.includes("--json status")), run.calls.join("\n"));
		assert.ok(lists.some((call) => call.includes("displayTitle")), run.calls.join("\n"));
		assert.deepEqual(run.did("release delete"), ["release delete v2026.11.16-1 --yes"]);
	});
});
