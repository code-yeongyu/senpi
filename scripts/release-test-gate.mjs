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

import { execFileSync } from "node:child_process";

export const REQUIRED_CHECK_NAME = "Check and test";

/** What `packages/ai/scripts/generate-models.ts` writes: the aggregator and the provider shards/data. */
export const REGENERATED_CATALOG_PATHS = ["packages/ai/src/models.generated.ts", "packages/ai/src/providers"];

/**
 * True when the release's catalog regeneration left the catalog different from HEAD (a changed or a
 * new file). HEAD's CI ran on the old catalog, so it says nothing about the regenerated one (senpi#2645).
 * @param {string} cwd repository root
 */
export function catalogChangedSinceHead(cwd) {
	const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", ...REGENERATED_CATALOG_PATHS], {
		cwd,
		encoding: "utf8",
	});
	return status.trim().length > 0;
}

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
 * @param {{forceTests: boolean, dryRun: boolean, sha: string, checkRuns: Array|null, catalogChanged?: boolean}} input
 *   checkRuns === null means the lookup failed (offline, gh missing, API error).
 * @returns {{skip: boolean, reason: string}}
 */
export function decideTestGate({ forceTests, dryRun, sha, checkRuns, catalogChanged = false }) {
	if (forceTests) {
		return { skip: false, reason: "--force-tests given; running the test gate unconditionally" };
	}
	if (dryRun) {
		return { skip: false, reason: "dry-run previews the real gate; tests still listed" };
	}
	if (catalogChanged) {
		return {
			skip: false,
			reason: "the regeneration changed the model catalog and HEAD's CI ran on the old one; running the full test gate on the regenerated tree",
		};
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
