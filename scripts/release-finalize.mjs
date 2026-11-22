#!/usr/bin/env node
/**
 * Finish a release once BOTH of its halves are done, without a runner waiting for either (senpi#6851).
 *
 * Build Binaries stages the draft GitHub Release after the full binary smoke, and the publish-only `publish-npm.yml`
 * run it dispatched publishes npm. Each side runs this script when its own half is done: Build Binaries' `finalize-release`
 * job after smoke and staging, and the publish run's `finalize-github-release` job after its `release` job. The script
 * reads both runs' job results. While the other half is still going it does nothing, since the other side's job will
 * see both results. Once both are known it does what the jobs that used to wait for npm did:
 *
 *   npm published, staging succeeded       -> publish the draft (already public: nothing to do)
 *   npm published, the binary smoke failed  -> scripts/release-smoke-failure-issue.mjs (rollback issue), exit 1
 *   npm published, staging failed/cancelled -> scripts/release-draft-cleanup.sh (keeps the draft npm has), exit 1
 *   npm not published                       -> scripts/release-draft-cleanup.sh when a draft can exist, exit 1
 *
 * Both jobs share one concurrency group per tag, and every action is idempotent, so a second run repeats nothing.
 *
 *   node scripts/release-finalize.mjs
 *
 * Env: RELEASE_TAG (vX), GH_REPO, BUILD_RUN_ID, PUBLISH_RUN_ID (empty when the dispatch failed before finding it),
 * DISPATCH_RESULT (Build Binaries' publish-npm job result; set only on the Build Binaries side).
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { failedSmokeRunners } from "./release-smoke-failure-issue.mjs";

const scriptsDir = fileURLToPath(new URL(".", import.meta.url));
const STAGE_JOB = "stage-github-release";
const PUBLISH_JOB = "release";

/** Staging's result, or `pending` while it can still run. A finished run without the job never staged a draft. */
export function stageState(jobs, runStatus) {
	const stage = jobs.find((job) => job.name === STAGE_JOB);
	if (stage?.status === "completed") return stage.conclusion;
	return runStatus === "completed" ? "skipped" : "pending";
}

/** `success`, `failure` or `pending` for the npm half: the publish run's `release` job is the only publisher. */
export function npmState({ dispatchResult, publishRunId, jobs, runStatus }) {
	if ((dispatchResult && dispatchResult !== "success") || !publishRunId) return "failure";
	const release = jobs.find((job) => job.name === PUBLISH_JOB);
	if (release?.status === "completed") return release.conclusion === "success" ? "success" : "failure";
	return runStatus === "completed" ? "failure" : "pending";
}

/** What to do once: `wait`, `publish`, `report`, `cleanup` or `none`, and the exit code. */
export function finalizeDecision({ npm, stage, smokeFailed }) {
	if (npm === "pending" || stage === "pending") return { action: "wait", exit: 0 };
	if (npm === "success") {
		if (stage === "success") return { action: "publish", exit: 0 };
		if (smokeFailed) return { action: "report", exit: 1 };
		if (stage === "skipped") return { action: "none", exit: 1 };
		return { action: "cleanup", exit: 1 };
	}
	return stage === "skipped" ? { action: "none", exit: 1 } : { action: "cleanup", exit: 1 };
}

function gh(args) {
	const result = spawnSync("gh", args, { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

function runJobs(repo, runId) {
	return JSON.parse(gh(["api", "--paginate", "--slurp", `repos/${repo}/actions/runs/${runId}/jobs`])).flatMap((page) => page.jobs);
}

const runStatus = (repo, runId) => gh(["api", `repos/${repo}/actions/runs/${runId}`, "--jq", ".status"]);

function runChild(command, args, env) {
	const result = spawnSync(command, args, { stdio: "inherit", env: { ...process.env, ...env } });
	return result.status ?? 1;
}

function publishDraft(tag) {
	const draft = spawnSync("gh", ["release", "view", tag, "--json", "isDraft", "--jq", ".isDraft"], { encoding: "utf8" }).stdout.trim();
	if (draft === "false") {
		process.stdout.write(`GitHub Release ${tag} is already published; nothing to do.\n`);
		return true;
	}
	if (draft !== "true") {
		process.stdout.write(`::error::Draft GitHub Release ${tag} does not exist.\n`);
		return false;
	}
	gh(["release", "edit", tag, "--draft=false"]);
	process.stdout.write(`Published GitHub Release ${tag}.\n`);
	return true;
}

function main() {
	const { RELEASE_TAG, GH_REPO, BUILD_RUN_ID, PUBLISH_RUN_ID = "", DISPATCH_RESULT = "" } = process.env;
	if (!RELEASE_TAG || !GH_REPO || !BUILD_RUN_ID) throw new Error("RELEASE_TAG, GH_REPO and BUILD_RUN_ID are required");
	const buildJobs = runJobs(GH_REPO, BUILD_RUN_ID);
	const stage = stageState(buildJobs, buildJobs.some((job) => job.name === STAGE_JOB && job.status === "completed") ? "" : runStatus(GH_REPO, BUILD_RUN_ID));
	const smokeFailed = failedSmokeRunners(buildJobs).length > 0;
	let npm = npmState({ dispatchResult: DISPATCH_RESULT, publishRunId: PUBLISH_RUN_ID, jobs: [], runStatus: "" });
	if (npm !== "failure") {
		const publishJobs = runJobs(GH_REPO, PUBLISH_RUN_ID);
		const done = publishJobs.some((job) => job.name === PUBLISH_JOB && job.status === "completed");
		npm = npmState({ dispatchResult: DISPATCH_RESULT, publishRunId: PUBLISH_RUN_ID, jobs: publishJobs, runStatus: done ? "" : runStatus(GH_REPO, PUBLISH_RUN_ID) });
	}
	const decision = finalizeDecision({ npm, stage, smokeFailed });
	process.stdout.write(`${RELEASE_TAG}: npm ${npm}, staging ${stage}, smoke ${smokeFailed ? "failed" : "passed"} -> ${decision.action}\n`);
	const cleanup = () =>
		runChild("bash", [`${scriptsDir}release-draft-cleanup.sh`], {
			RELEASE_TAG,
			PUBLISH_RUN_ID,
			PUBLISH_JOB_RESULT: DISPATCH_RESULT || "success",
			PUBLISH_RELEASE_RESULT: npm,
			STAGE_JOB_RESULT: stage,
		});
	switch (decision.action) {
		case "wait":
			process.stdout.write("The other half of the release is still running; its finalize job finishes the release.\n");
			return 0;
		case "publish":
			if (publishDraft(RELEASE_TAG)) return 0;
			cleanup();
			return 1;
		case "report": {
			const attempt = buildJobs.find((job) => /^smoke-test-binaries /.test(job.name))?.run_attempt ?? 1;
			runChild(process.execPath, [`${scriptsDir}release-smoke-failure-issue.mjs`], {
				RUN_ID: BUILD_RUN_ID,
				RUN_ATTEMPT: String(attempt),
				RUN_URL: `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${GH_REPO}/actions/runs/${BUILD_RUN_ID}`,
			});
			return 1;
		}
		case "cleanup":
			cleanup();
			break;
		default:
			break;
	}
	process.stdout.write(`::error::${RELEASE_TAG} was not released: npm ${npm}, staging ${stage}.\n`);
	return decision.exit;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
