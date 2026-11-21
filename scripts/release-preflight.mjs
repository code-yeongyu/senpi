#!/usr/bin/env node
/**
 * The first-minute `preflight` job of every release dispatch that is not publish-only (`.github/workflows/publish-npm.yml`).
 *
 *   node scripts/release-preflight.mjs --github-output <file> [--sha <sha>] [--version <v>] [--force-tests] [--dry-run]
 *
 * Everything a dispatch can know before it installs, builds or tests anything is checked here, so a release never fails
 * at minute 27 on something known at minute 0: the ref (a live run only from main), the version (well formed and not
 * already tagged or published), the commit (`--sha` one of main's own commits), the publish set (every name known to
 * the registry), main's macOS/Windows legs, and the commit's hosted "Check and test" (a known-red run stops the
 * release now; an unfinished one is left for the release job to wait for). Every refusal is collected and printed, then
 * the job fails; a dry run prints them as warnings and passes. A catalog refresh PR open longer than its workflow's
 * MAX_STALE_DAYS is printed as a warning, never a refusal: the release ships main's catalog, and the operator should
 * know when that catalog is stale (senpi#2287).
 *
 * It also fixes what every later job uses: `base_sha` (the `--sha` input, else the checked-out commit; resolved once,
 * here, and printed in full) and `version` (fixed now, so a run that crosses 00:00 UTC cannot change it).
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { computeNextVersion } from "./calver.mjs";
import { lookupCiCheckRuns, platformBlockers } from "./release-ci-evidence.mjs";
import { assertRegistryPackagesKnown, queryNpmRegistry } from "./npm-registry.mjs";
import { assertReleasableCommit } from "./release-pin.mjs";
import { assertLiveRunOnMain } from "./release-ref-guard.mjs";
import { planCiEvidence } from "./release-test-gate.mjs";

const VERSION_RE = /^\d{4}\.\d{1,2}\.\d{1,2}(-\d+)?$/;
const DAY_MS = 86_400_000;

/** Each catalog refresh branch and its workflow's MAX_STALE_DAYS (model-catalog-refresh.yml, opengateway-catalog-refresh.yml). */
export const CATALOG_REFRESH_BRANCHES = [
	{ branch: "automation/model-catalog-refresh", maxStaleDays: 3 },
	{ branch: "automation/opengateway-catalog-refresh", maxStaleDays: 14 },
];

/**
 * Warnings for refresh PRs that have waited longer than their limit.
 * @param {Array<{branch: string, number: number, createdAt: string}>} open the open refresh PRs
 * @param {number} now epoch ms
 */
export function staleCatalogNotices(open, now) {
	const notices = [];
	for (const { branch, maxStaleDays } of CATALOG_REFRESH_BRANCHES) {
		for (const pr of open.filter((entry) => entry.branch === branch)) {
			const days = Math.floor((now - Date.parse(pr.createdAt)) / DAY_MS);
			if (days > maxStaleDays) {
				notices.push(`catalog refresh #${pr.number} (${branch}) has waited ${days} days (limit ${maxStaleDays}); this release ships main's older catalog`);
			}
		}
	}
	return notices;
}
const FULL_SHA = /^[0-9a-f]{40}$/;

/** `$GITHUB_OUTPUT` lines for the preflight job's outputs. */
export function formatPreflightOutputs({ baseSha, version }) {
	return `base_sha=${baseSha}\nversion=${version}\n`;
}

/**
 * Run every check, collecting refusals instead of stopping at the first, so one dispatch reports everything wrong.
 * @param {{
 *   sha: string|undefined, version: string|undefined, forceTests: boolean,
 *   headSha: () => string,
 *   assertOnMain: (sha: string) => void,
 *   nextVersion: () => string,
 *   tagExists: (tag: string) => boolean,
 *   published: (version: string) => boolean,
 *   assertPublishSetKnown: () => void,
 *   platformBlockers: () => string[],
 *   checkRuns: (sha: string) => Array|null,
 * }} deps
 * @returns {{baseSha: string, version: string, refusals: string[], notes: string[]}}
 */
export function runPreflight(deps) {
	const refusals = [];
	const notes = [];
	const attempt = (check) => {
		try {
			check();
		} catch (error) {
			refusals.push(error instanceof Error ? error.message : String(error));
		}
	};
	let baseSha = deps.sha ?? deps.headSha();
	if (deps.sha !== undefined) attempt(() => deps.assertOnMain(deps.sha));
	if (!FULL_SHA.test(baseSha)) refusals.push(`resolved base ${JSON.stringify(baseSha)} is not a full sha`);

	let version = deps.version ?? "";
	if (deps.version !== undefined) {
		if (!VERSION_RE.test(deps.version)) {
			refusals.push(`invalid version ${JSON.stringify(deps.version)} (expected YYYY.M.D or YYYY.M.D-N)`);
		} else {
			attempt(() => {
				if (deps.tagExists(`v${deps.version}`)) throw new Error(`tag v${deps.version} already exists; pick the next version`);
			});
			attempt(() => {
				if (deps.published(deps.version)) throw new Error(`version ${deps.version} is already published to npm`);
			});
		}
	} else {
		attempt(() => {
			version = deps.nextVersion();
		});
	}

	attempt(deps.assertPublishSetKnown);
	for (const blocker of deps.platformBlockers()) refusals.push(`a macOS/Windows job is red on main: ${blocker}`);
	if (!deps.forceTests && FULL_SHA.test(baseSha)) {
		const plan = planCiEvidence({ sha: baseSha, checkRuns: deps.checkRuns(baseSha) });
		if (plan.action === "stop") refusals.push(`CI failed on ${baseSha.slice(0, 12)}: ${plan.reason}; fix main before releasing`);
		else notes.push(`test gate: ${plan.reason}${plan.action === "reuse" ? "" : "; the release job waits for it"}`);
	}
	return { baseSha, version, refusals, notes };
}

const log = (line) => process.stdout.write(`[preflight] ${line}\n`);

/** The open catalog refresh PRs; a failed read is reported and yields none, since this check only warns. */
function openRefreshPrs(capture) {
	try {
		return CATALOG_REFRESH_BRANCHES.flatMap(({ branch }) =>
			JSON.parse(capture("gh", ["pr", "list", "--head", branch, "--base", "main", "--state", "open", "--json", "number,createdAt"])).map(
				(pr) => ({ branch, ...pr }),
			),
		);
	} catch (error) {
		process.stdout.write(`::warning::could not read the open catalog refresh PRs: ${error instanceof Error ? error.message : String(error)}\n`);
		return [];
	}
}

function main() {
	const { values } = parseArgs({
		options: {
			sha: { type: "string" },
			version: { type: "string" },
			"force-tests": { type: "boolean", default: false },
			"dry-run": { type: "boolean", default: false },
			"github-output": { type: "string" },
		},
	});
	if (!values["github-output"]) throw new Error("--github-output is required");
	const dryRun = values["dry-run"];
	assertLiveRunOnMain({ dryRun, env: process.env, what: "the release" });
	const capture = (bin, args) => execFileSync(bin, args, { encoding: "utf8" });
	const runCommand = (bin, args) => execFileSync(bin, args, { stdio: "inherit" });
	const result = runPreflight({
		sha: values.sha || undefined,
		version: values.version || undefined,
		forceTests: values["force-tests"],
		headSha: () => capture("git", ["rev-parse", "HEAD"]).trim(),
		assertOnMain: (sha) => assertReleasableCommit(sha, runCommand, log, capture),
		nextVersion: computeNextVersion,
		tagExists: (tag) => capture("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]).trim() !== "",
		published: (version) => queryNpmRegistry(`@code-yeongyu/senpi@${version}`, "version") !== null,
		assertPublishSetKnown: () => assertRegistryPackagesKnown(),
		platformBlockers,
		checkRuns: lookupCiCheckRuns,
	});
	for (const refusal of result.refusals) {
		process.stdout.write(`::${dryRun ? "warning" : "error"}::${refusal}\n`);
	}
	for (const note of result.notes) log(note);
	for (const notice of staleCatalogNotices(openRefreshPrs(capture), Date.now())) process.stdout.write(`::warning::${notice}\n`);
	if (result.refusals.length > 0 && !dryRun) {
		throw new Error(`${result.refusals.length} preflight check(s) refused the release; nothing was built, tested or pushed`);
	}
	log(`release version: ${result.version}`);
	// The base is resolved here, once: the matrix jobs and release.mjs --sha take this output and never look at main
	// again (release-train ruling on senpi#6642).
	log(`base commit for every later job: ${result.baseSha}`);
	appendFileSync(values["github-output"], formatPreflightOutputs(result));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	try {
		main();
	} catch (error) {
		process.stderr.write(`[preflight] error: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}
