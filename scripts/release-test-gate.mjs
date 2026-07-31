#!/usr/bin/env node
/**
 * Decide whether the release test gate must run the full suite locally.
 *
 * The canonical release flow already requires CI green on `main` before a release
 * commit is cut, so re-running `CI=1 npm test` locally duplicates a gate GitHub
 * already ran for the exact same tree. This module answers one question: does HEAD
 * already carry a green "Check and test" check run? Pure decision logic lives here
 * (unit-testable without network); `release.mjs` owns the `gh` lookup.
 */

export const REQUIRED_CHECK_NAME = "Check and test";

/**
 * @param {Array<{name: string, status: string, conclusion: string|null, head_sha: string}>} checkRuns
 * @param {string} sha
 */
export function isCiCheckGreen(checkRuns, sha) {
	return checkRuns.some(
		(run) =>
			run.name === REQUIRED_CHECK_NAME &&
			run.status === "completed" &&
			run.conclusion === "success" &&
			run.head_sha === sha,
	);
}

/**
 * @param {{forceTests: boolean, dryRun: boolean, sha: string, checkRuns: Array|null}} input
 *   checkRuns === null means the lookup failed (offline, gh missing, API error).
 * @returns {{skip: boolean, reason: string}}
 */
export function decideTestGate({ forceTests, dryRun, sha, checkRuns }) {
	if (forceTests) {
		return { skip: false, reason: "--force-tests given; running the test gate unconditionally" };
	}
	if (dryRun) {
		return { skip: false, reason: "dry-run previews the real gate; tests still listed" };
	}
	if (checkRuns === null) {
		return { skip: false, reason: "CI check lookup failed; running the test gate locally" };
	}
	if (isCiCheckGreen(checkRuns, sha)) {
		return {
			skip: true,
			reason: `HEAD ${sha.slice(0, 12)} already has a green "${REQUIRED_CHECK_NAME}" CI run; skipping the duplicated local test gate`,
		};
	}
	return { skip: false, reason: `no green "${REQUIRED_CHECK_NAME}" check for HEAD ${sha.slice(0, 12)}` };
}
