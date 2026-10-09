#!/usr/bin/env node
/**
 * The release's test evidence (senpi#2943).
 *
 * A release never re-runs the test suite: it reuses the green "Check and test" run CI reported for the exact
 * commit it tags, the fan-in that succeeds only when every CI shard and required job passed. This module holds the
 * pure decisions (unit-testable without network): whether the regenerated catalog differs from HEAD, what to do
 * with the check runs CI reported, and the wait loop. `release.mjs` owns the `gh` and `git` calls.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

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

export const CATALOG_MANIFEST = "packages/ai/src/providers/data/.manifest.json";

/**
 * True when two catalog manifests differ only in `generatedAt`, the timestamp every regeneration stamps.
 * @param {string} before manifest text at HEAD
 * @param {string} after regenerated manifest text
 */
export function isTimestampOnlyManifestChange(before, after) {
	const { generatedAt: _before, ...beforeRest } = JSON.parse(before);
	const { generatedAt: _after, ...afterRest } = JSON.parse(after);
	return isDeepStrictEqual(beforeRest, afterRest);
}

/**
 * Restore the catalog manifest when the regeneration changed nothing but its `generatedAt` stamp, so an unchanged
 * catalog reads as unchanged. Without this every regeneration looked like drift.
 * @param {string} cwd repository root
 * @returns {boolean} whether the stamp-only change was discarded
 */
export function discardTimestampOnlyCatalogChange(cwd) {
	const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", ...REGENERATED_CATALOG_PATHS], {
		cwd,
		encoding: "utf8",
	});
	const changed = status
		.split("\n")
		.map((line) => line.slice(3).trim())
		.filter(Boolean);
	if (changed.length !== 1 || changed[0] !== CATALOG_MANIFEST) return false;
	const before = execFileSync("git", ["show", `HEAD:${CATALOG_MANIFEST}`], { cwd, encoding: "utf8" });
	const after = readFileSync(join(cwd, CATALOG_MANIFEST), "utf8");
	if (!isTimestampOnlyManifestChange(before, after)) return false;
	execFileSync("git", ["checkout", "--", CATALOG_MANIFEST], { cwd });
	return true;
}

const SUPERSEDED_CONCLUSIONS = new Set(["cancelled", "stale", "skipped"]);

/**
 * What the release does with the "Check and test" runs CI reported for `sha` (senpi#2943). That fan-in check
 * succeeds only when every CI shard and required job passed, so a green one is the release's test evidence and
 * the release never re-runs the suite itself.
 * The fan-in runs `if: always()`, so when a newer push cancels the workflow run the fan-in still runs and reports
 * `failure`. The lookup therefore attaches the workflow run's own status and conclusion to a failed fan-in, and a
 * failure inside a cancelled workflow run is "superseded", not a red CI.
 * @param {{sha: string, checkRuns: Array<{name: string, status: string, conclusion: string|null, head_sha: string, id?: number, workflowStatus?: string, workflowConclusion?: string|null}>|null}} input
 *   checkRuns === null means the lookup failed (offline, gh missing, API error).
 * @returns {{action: "reuse"|"wait"|"stop"|"superseded", reason: string}}
 */
export function planCiEvidence({ sha, checkRuns }) {
	const short = sha.slice(0, 12);
	if (checkRuns === null) return { action: "wait", reason: `the CI lookup for ${short} failed` };
	const runs = checkRuns
		.map((run, index) => ({ run, order: run.id ?? index }))
		.filter(({ run }) => run.name === REQUIRED_CHECK_NAME && run.head_sha === sha)
		.sort((a, b) => a.order - b.order)
		.map(({ run }) => run);
	const latest = runs.at(-1);
	if (!latest) return { action: "wait", reason: `no "${REQUIRED_CHECK_NAME}" run for ${short} yet` };
	if (latest.status !== "completed") {
		return { action: "wait", reason: `"${REQUIRED_CHECK_NAME}" for ${short} is ${latest.status}` };
	}
	if (latest.conclusion === "success") {
		return { action: "reuse", reason: `${short} has a green "${REQUIRED_CHECK_NAME}" run; it is the release's test evidence` };
	}
	if (latest.conclusion === "failure" && latest.workflowConclusion === "cancelled") {
		return { action: "superseded", reason: `the CI run for ${short} was cancelled, most likely by a newer push` };
	}
	if (latest.conclusion === "failure" && latest.workflowStatus !== undefined && latest.workflowStatus !== "completed") {
		return { action: "wait", reason: `"${REQUIRED_CHECK_NAME}" for ${short} failed; waiting for its workflow run to finish to tell a cancellation from a red CI` };
	}
	if (SUPERSEDED_CONCLUSIONS.has(latest.conclusion ?? "")) {
		return { action: "superseded", reason: `"${REQUIRED_CHECK_NAME}" for ${short} was ${latest.conclusion}` };
	}
	return { action: "stop", reason: `"${REQUIRED_CHECK_NAME}" for ${short} concluded ${latest.conclusion}` };
}

/**
 * Wait until HEAD (or the main commit that superseded its CI run) has a green "Check and test" run, and return
 * that commit. Never runs the suite: a red run stops the release, and no result within `timeoutMs` fails it with
 * the reason, so an operator reruns CI rather than the release re-running the whole suite serially.
 * @param {{timeoutMs: number, pollMs: number}} options
 * @param {{
 *   lookupCheckRuns: (sha: string) => Array|null,
 *   sleep: (ms: number) => void,
 *   now: () => number,
 *   headSha: () => string,
 *   remoteMain: () => {tip: string, contains: (sha: string) => boolean},
 *   fastForwardTo: (sha: string) => void,
 *   log: (message: string) => void,
 * }} deps
 * @returns {string} the commit whose green CI the release reuses
 */
export function awaitCiEvidence({ timeoutMs, pollMs }, deps) {
	const startedAt = deps.now();
	let sha = deps.headSha();
	for (;;) {
		const plan = planCiEvidence({ sha, checkRuns: deps.lookupCheckRuns(sha) });
		deps.log(`test gate: ${plan.reason}`);
		if (plan.action === "reuse") return sha;
		if (plan.action === "stop") throw new Error(`CI failed on ${sha.slice(0, 12)}: ${plan.reason}; fix main before releasing`);
		if (plan.action === "superseded") {
			// A newer main push cancels this commit's CI. The release then moves onto that newer commit, so the
			// commit it tags is always one whose own CI is green. It never tags on top of a main that dropped it.
			const main = deps.remoteMain();
			if (main.tip !== sha) {
				if (!main.contains(sha)) {
					throw new Error(
						`main moved to ${main.tip.slice(0, 12)}, which does not contain ${sha.slice(0, 12)}; restart the release from the new main`,
					);
				}
				deps.log(`test gate: main moved to ${main.tip.slice(0, 12)}; releasing that commit once its CI is green`);
				deps.fastForwardTo(main.tip);
				sha = main.tip;
				continue;
			}
		}
		if (deps.now() - startedAt >= timeoutMs) {
			throw new Error(
				`no ${REQUIRED_CHECK_NAME} result for ${sha.slice(0, 12)} within ${Math.round(timeoutMs / 60_000)} min; rerun CI on that commit and dispatch the release again (a local release can pass --force-tests instead)`,
			);
		}
		deps.sleep(pollMs);
	}
}
