/**
 * The release's test evidence (moved out of `release.mjs`, senpi#6642). A default release waits for its commit's green
 * "Check and test" CI run (senpi#2943); `--force-tests` runs the suite in the release job; `--shard-results` reuses the
 * forced-suite matrix jobs of the same workflow run and only verifies what they tested.
 */

import { execFileSync } from "node:child_process";
import { latestPlatformResults, releaseBlockers } from "./ci-platform-red.mjs";
import { captureOutput } from "./release-capture.mjs";
import { captureCommand, dryRunLog, log, runCommand } from "./release-commands.mjs";
import { assertForcedSuiteResults } from "./release-forced-suite-results.mjs";
import { assertReleasableCommit } from "./release-pin.mjs";
import { awaitCiEvidence, planCiEvidence, REQUIRED_CHECK_NAME } from "./release-test-gate.mjs";

/** The "Check and test" check runs GitHub reports for `sha`, or null when the lookup failed. */
export function lookupCiCheckRuns(sha) {
	try {
		const raw = captureOutput("gh", [
			"api",
			`repos/{owner}/{repo}/commits/${sha}/check-runs`,
			"--paginate",
			"--slurp",
		]);
		const pages = JSON.parse(raw);
		const runs = Array.isArray(pages)
			? pages.flatMap((page) => (Array.isArray(page.check_runs) ? page.check_runs : []))
			: Array.isArray(pages.check_runs)
				? pages.check_runs
				: [];
		return runs.map((run) => {
			const checkRun = {
				id: run.id,
				name: run.name,
				status: run.status,
				conclusion: run.conclusion,
				head_sha: run.head_sha,
			};
			// A newer push cancels the workflow run, but the `always()` fan-in still reports `failure`: read the
			// workflow run's own outcome so the gate can tell a cancellation from a red CI.
			if (run.name === REQUIRED_CHECK_NAME && run.conclusion === "failure" && run.check_suite?.id) {
				Object.assign(checkRun, lookupWorkflowRun(run.check_suite.id));
			}
			return checkRun;
		});
	} catch {
		return null;
	}
}

function lookupWorkflowRun(checkSuiteId) {
	const raw = execFileSync(
		"gh",
		["api", `repos/{owner}/{repo}/actions/runs?check_suite_id=${checkSuiteId}&per_page=1`],
		{
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const workflowRun = JSON.parse(raw).workflow_runs?.[0];
	return workflowRun ? { workflowStatus: workflowRun.status, workflowConclusion: workflowRun.conclusion } : {};
}

const CI_EVIDENCE_TIMEOUT_MS = 40 * 60_000;
const CI_EVIDENCE_POLL_MS = 30_000;

function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function remoteMain() {
	runCommand("git", ["fetch", "origin", "main"]);
	const tip = captureCommand("git", ["rev-parse", "origin/main"]).trim();
	return {
		tip,
		contains: (sha) => {
			try {
				runCommand("git", ["merge-base", "--is-ancestor", sha, tip]);
				return true;
			} catch {
				return false;
			}
		},
	};
}

/** Why a release with a CI-basis receipt stops on a red hosted run; the dry run previews the same words. */
function receiptRefusal(sha, reason) {
	return `CI failed on ${sha.slice(0, 12)}: ${reason}; a ci_basis_receipt waives only the wait for hosted CI, not a red result`;
}

/**
 * The release's test evidence is CI's sharded run, never a second serial run of the suite here (senpi#2943).
 * The release ships the model catalog main committed, which that CI run tested; catalog changes reach main only through
 * the refresh workflows' own pull requests (senpi#2287). The release waits for its commit's green "Check and test",
 * unless the release workflow accepted a CI-basis receipt for the pinned commit (`ciBasisReceipt`, senpi#6859).
 */
export function secureCiEvidence(dryRun, forceTests, pinnedSha, ciBasisReceipt) {
	if (dryRun) {
		const sha = pinnedSha ?? captureCommand("git", ["rev-parse", "HEAD"]).trim();
		const plan = planCiEvidence({ sha, checkRuns: lookupCiCheckRuns(sha) });
		dryRunLog(`test gate (preview, ${pinnedSha ? "pinned commit" : "HEAD"}): ${plan.reason}`);
		dryRunLog(
			forceTests
				? "no CI wait (--force-tests runs the suite in this job)"
				: ciBasisReceipt
					? plan.action === "stop"
						? `the live run would refuse: ${receiptRefusal(sha, plan.reason)}`
						: `no CI wait (hosted CI wait waived by ci_basis_receipt ${ciBasisReceipt})`
					: 'wait for the release commit\'s green "Check and test"',
		);
		return;
	}
	if (forceTests) {
		log(
			"test gate: --force-tests given; the suite runs in this job on the release code, before version and changelog stamping",
		);
		return;
	}
	if (ciBasisReceipt) {
		// The receipt waives the wait, not a known result: hosted CI is read once, and a red run still stops the release.
		const plan = planCiEvidence({ sha: pinnedSha, checkRuns: lookupCiCheckRuns(pinnedSha) });
		log(`test gate: ${plan.reason}`);
		if (plan.action === "stop") {
			throw new Error(receiptRefusal(pinnedSha, plan.reason));
		}
		log(`test gate: hosted CI wait waived by ci_basis_receipt ${ciBasisReceipt} for the pinned commit ${pinnedSha}`);
		return;
	}
	awaitCiEvidence(
		{ timeoutMs: CI_EVIDENCE_TIMEOUT_MS, pollMs: CI_EVIDENCE_POLL_MS },
		{
			lookupCheckRuns: lookupCiCheckRuns,
			sleep: sleepSync,
			now: Date.now,
			headSha: () => captureCommand("git", ["rev-parse", "HEAD"]).trim(),
			remoteMain,
			fastForwardTo: (sha) => runCommand("git", ["merge", "--ff-only", sha]),
			log,
			pinned: pinnedSha !== null,
		},
	);
}

/**
 * The evidence of a release whose suite ran in the forced-suite matrix jobs (senpi#6642): the job checked out the
 * dispatched commit `sha`, and every matrix job reported a pass on exactly that commit.
 * Every check is read-only, so a dry run performs them too. Nothing is re-run here.
 */
export function verifyTestedRelease({ sha, shardResults }) {
	const head = captureCommand("git", ["rev-parse", "HEAD"]).trim();
	if (head !== sha) {
		throw new Error(
			`HEAD is ${head.slice(0, 12)}, not the tested commit ${sha.slice(0, 12)}; the release job must check out the prepare job's base_sha`,
		);
	}
	assertReleasableCommit(sha, runCommand, log, captureCommand);
	const parts = assertForcedSuiteResults({ dir: shardResults, testedSha: sha });
	log(`test gate: ${parts.length} forced-suite matrix jobs passed on ${sha.slice(0, 12)}`);
}

/** Each red macOS/Windows job in the latest settled main runs, one line per job (senpi#6834). */
export function platformBlockers() {
	return releaseBlockers(latestPlatformResults((args) => captureOutput("gh", args)));
}

/**
 * Pull requests run Linux only (senpi#6834), so macOS and Windows are tested on main after each merge. Whatever its
 * test evidence, a release refuses while the latest settled main run of any workflow with macOS/Windows legs has a
 * failed macOS/Windows job (platform-red.yml has filed the tracking issue for it). A dry run only reports it.
 */
export function assertPlatformsGreen(dryRun) {
	const blockers = platformBlockers();
	if (blockers.length === 0) {
		(dryRun ? dryRunLog : log)("platform gate: no macOS/Windows job is red in the latest main runs");
		return;
	}
	if (dryRun) {
		for (const blocker of blockers) dryRunLog(`platform gate would refuse: ${blocker}`);
		return;
	}
	throw new Error(`a macOS/Windows job is red on main; fix it before releasing:\n${blockers.map((line) => `  ${line}`).join("\n")}`);
}
