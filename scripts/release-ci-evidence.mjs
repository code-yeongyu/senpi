/**
 * The release's test evidence (moved out of `release.mjs`, senpi#6642). A default release waits for its commit's green
 * "Check and test" CI run (senpi#2943); `--force-tests` runs the suite in the release job; `--tested-sha` reuses the
 * forced-suite matrix jobs of the same workflow run and only verifies what they tested.
 */

import { execFileSync } from "node:child_process";
import { runGenerateModels, runProviderDefaultsCheck } from "./release-artifacts.mjs";
import { captureOutput } from "./release-capture.mjs";
import { captureCommand, dryRunLog, gitCommit, log, runCommand } from "./release-commands.mjs";
import { assertForcedSuiteResults } from "./release-forced-suite-results.mjs";
import { assertReleasableCommit } from "./release-pin.mjs";
import {
	awaitCiEvidence,
	catalogChangedSinceHead,
	catalogCommitMessage,
	changedCatalogPaths,
	discardTimestampOnlyCatalogChange,
	planCiEvidence,
	REGENERATED_CATALOG_PATHS,
	REQUIRED_CHECK_NAME,
} from "./release-test-gate.mjs";
import { assertTestedLineage } from "./release-tested-lineage.mjs";

function lookupCiCheckRuns(sha) {
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

/**
 * The release's test evidence is CI's sharded run, never a second serial run of the suite here (senpi#2943).
 * A regenerated model catalog is committed on the release only and requires --force-tests (never pushed untested); the
 * release ships (the gap behind senpi#2645); then the release waits for that commit's green "Check and test".
 */
export function secureCiEvidence(version, dryRun, forceTests, pinnedSha) {
	runGenerateModels(dryRun, runCommand, log, dryRunLog);
	runProviderDefaultsCheck(dryRun, runCommand, log, dryRunLog);
	if (dryRun) {
		dryRunLog(
			`if the catalog changed: git commit ${REGENERATED_CATALOG_PATHS.join(" ")} on the release only (requires --force-tests)`,
		);
		const sha = pinnedSha ?? captureCommand("git", ["rev-parse", "HEAD"]).trim();
		const plan = planCiEvidence({ sha, checkRuns: lookupCiCheckRuns(sha) });
		dryRunLog(`test gate (preview, ${pinnedSha ? "pinned commit" : "HEAD"}): ${plan.reason}`);
		dryRunLog(
			forceTests
				? "no CI wait (--force-tests runs the suite in this job)"
				: 'wait for the release commit\'s green "Check and test"',
		);
		return;
	}
	if (discardTimestampOnlyCatalogChange(process.cwd())) {
		log("the regeneration changed only the catalog manifest's generatedAt stamp; keeping HEAD's catalog");
	}
	if (catalogChangedSinceHead(process.cwd())) {
		// A regenerated catalog is never pushed to main before this job has checked and tested it: v2026.10.19-1 pushed
		// one that dropped a model a test pinned, and main failed typecheck for every PR. It is committed on the release
		// only, and the forced suite plus `npm run check` run on it before anything is pushed.
		if (!forceTests) {
			throw new Error(
				"the regeneration changed the model catalog; dispatch with force_tests so this job tests that tree before anything reaches main",
			);
		}
		log(
			"the regeneration changed the model catalog; committing it on the release only (the forced suite and checks run on it)",
		);
		runCommand("git", ["add", "-A", "--", ...changedCatalogPaths(process.cwd())]);
		gitCommit(catalogCommitMessage(version), false);
	}
	if (forceTests) {
		log(
			"test gate: --force-tests given; the suite runs in this job on the release code, before version and changelog stamping",
		);
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
 * tested commit, which is `sha` itself or one catalog-only commit on it, and every matrix job reported a pass on it.
 * Every check is read-only, so a dry run performs them too. Nothing is regenerated or re-run here.
 */
export function verifyTestedRelease({ sha, testedSha, shardResults }) {
	const head = captureCommand("git", ["rev-parse", "HEAD"]).trim();
	if (head !== testedSha) {
		throw new Error(
			`HEAD is ${head.slice(0, 12)}, not the tested commit ${testedSha.slice(0, 12)}; the release job must check out the prepare job's tested_sha`,
		);
	}
	assertReleasableCommit(sha, runCommand, log, captureCommand);
	const lineage = assertTestedLineage({ base: sha, tested: testedSha, capture: captureCommand });
	const parts = assertForcedSuiteResults({ dir: shardResults, testedSha });
	log(
		`test gate: ${parts.length} forced-suite matrix jobs passed on ${testedSha.slice(0, 12)} ` +
			(lineage === "unchanged" ? "(the dispatched commit)" : `(the release-only catalog commit on ${sha.slice(0, 12)})`),
	);
}
