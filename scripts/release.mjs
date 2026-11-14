#!/usr/bin/env node
/**
 * Release script for the senpi monorepo (CalVer).
 *
 * Usage:
 *   node scripts/release.mjs               # compute next version via calver.mjs, run release
 *   node scripts/release.mjs --version <v> # explicit CalVer override (YYYY.M.D or YYYY.M.D-N)
 *   node scripts/release.mjs --dry-run     # preview every command and file write; modify nothing
 *   node scripts/release.mjs --help        # print usage
 *
 * Flow (matches AGENTS.md "Releasing"):
 *   1. Pre-flight: branch must be `main`; working tree must be clean (--dry-run warns
 *      and continues so the preview is usable during development).
 *   2. Resolve version: `--version` override or `computeNextVersion()` from calver.mjs.
 *   3. Test evidence (senpi#2943): regenerate the AI model catalog and check the bundled
 *      provider defaults against it. If the catalog changed, commit it on the release only and
 *      require --force-tests, so this job tests that tree before anything reaches `main`. Then wait for that commit's
 *      green "Check and test" run, the fan-in of every CI shard and required job. A red run
 *      stops the release; a run superseded by a newer `main` push moves the release onto
 *      that commit. The suite is never re-run here unless `--force-tests` asks for it.
 *      With `--tested-sha` (senpi#6642) the forced-suite matrix jobs of publish-npm.yml already regenerated the
 *      catalog and ran the suite on HEAD: this step only verifies HEAD's lineage from `--sha` and their result files.
 *   4. Write `version` into all release workspace package.json files directly (TAB indent,
 *      trailing newline). `npm version` is intentionally NOT used; the `-N` suffix on
 *      same-day re-releases looks like a prerelease tag to npm.
 *   5. Run `scripts/sync-versions.js` to propagate the new version to source
 *      inter-package deps, then refresh `package-lock.json` and
 *      `packages/coding-agent/install-lock/`.
 *   6. For each `packages/*\/CHANGELOG.md`, replace `## [Unreleased]` with
 *      `## [<version>] - <YYYY-MM-DD>`, remembering its subsection structure
 *      (`### Added`, `### Fixed`, ...) for re-insertion in step 8.
 *   7. Run `npm run check`, then `npm run build` (and `CI=1 npm test` only with
 *      `--force-tests`).
 *   8. Commit the release, tag it, re-insert a fresh `## [Unreleased]` block,
 *      commit the next-cycle changelog update, then push `main` and the new tag.
 *      GitHub Actions builds binaries and publishes from the pushed tag.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { computeNextVersion } from "./calver.mjs";
import {
	runClaudeCodeModelSupportReport,
	runInstallLock,
	runPackageLockRefresh,
} from "./release-artifacts.mjs";
import { CHANGELOGS, reAddUnreleasedSections, stampChangelogs } from "./release-changelog.mjs";
import { secureCiEvidence, verifyTestedRelease } from "./release-ci-evidence.mjs";
import { parseArgs, printUsage } from "./release-cli-args.mjs";
import {
	captureCommand,
	dryRunLog,
	gitCommit,
	gitPush,
	gitTag,
	log,
	runCommand,
	stageChangedFiles,
} from "./release-commands.mjs";
import { syncRemoteMainBeforePush } from "./release-git.mjs";
import { assertLiveRunOnMain } from "./release-ref-guard.mjs";
import { assertHeadOnOriginMain } from "./release-tested-lineage.mjs";
import { applyWorkspaceVersions, runSyncVersions } from "./release-packages.mjs";
import { preparePinnedRelease, syncPinnedReleaseIntoMain } from "./release-pin.mjs";
import {
	FORCED_CODING_AGENT_SHARDS,
	FORCED_TEST_SUITE_TIMEOUT_MS,
	runForcedTestSuite,
} from "./release-forced-test-suite.mjs";
import { compileFragments } from "./sync-changes-fragments.mjs";
import { assertRegistryPackagesKnown } from "./npm-registry.mjs";
import { fileURLToPath } from "node:url";

const VERSION_RE = /^\d{4}\.\d{1,2}\.\d{1,2}(-\d+)?$/;

function preflight(dryRun) {
	const branch = captureCommand("git", ["branch", "--show-current"]).trim();
	if (branch !== "main") {
		process.stderr.write(`[release] error: must be on main branch, currently on "${branch || "<detached>"}"\n`);
		process.exit(1);
	}
	// The name alone proves nothing (`git checkout -B main` names any commit main): HEAD must be on origin/main, or the
	// release-only catalog commit on top of a commit that is (senpi#6645).
	const onMain = assertHeadOnOriginMain({ runCommand, capture: captureCommand, log });
	log(onMain === "on-main" ? "on branch main, at a commit origin/main reaches" : "on branch main, at the release-only catalog commit on origin/main");

	const status = captureCommand("git", ["status", "--porcelain"]);
	if (status.trim().length === 0) {
		log("working tree clean");
		return;
	}
	if (dryRun) {
		log("warn: working tree has uncommitted changes (dry-run continues; live release would abort)");
		return;
	}
	process.stderr.write("[release] error: uncommitted changes detected:\n");
	process.stderr.write(status);
	process.exit(1);
}

function resolveVersion(opts) {
	if (opts.version !== null) {
		if (!VERSION_RE.test(opts.version)) {
			process.stderr.write(
				`[release] error: invalid --version "${opts.version}" ` + "(expected YYYY.M.D or YYYY.M.D-N)\n",
			);
			process.exit(1);
		}
		log(`using explicit version: ${opts.version}`);
		return opts.version;
	}
	log("computing next CalVer version via scripts/calver.mjs ...");
	const version = computeNextVersion();
	if (!VERSION_RE.test(version)) {
		process.stderr.write(`[release] error: calver returned invalid version "${version}"\n`);
		process.exit(1);
	}
	return version;
}

function todayISO() {
	return new Date().toISOString().slice(0, 10);
}

const capturedChangelogSubsections = new Map();

function runCheck(dryRun) {
	if (dryRun) {
		dryRunLog("npm run check");
		return;
	}
	log("npm run check");
	runCommand("npm", ["run", "check"]);
}

function runClean(dryRun) {
	if (dryRun) {
		dryRunLog("npm run clean");
		return;
	}
	log("npm run clean");
	runCommand("npm", ["run", "clean"]);
}

function runBuild(dryRun) {
	if (dryRun) {
		dryRunLog("npm run build");
		return;
	}
	log("npm run build");
	runCommand("npm", ["run", "build"]);
}

/**
 * The forced suite runs right after the test-evidence step, on the release's code and catalog but before any
 * version or changelog stamping: a test that reads a real CHANGELOG.md must see the tree CI would (v2026.10.16 release
 * run 38824836070 failed when the suite ran on stamped changelogs). It cleans and builds first; the release cleans and
 * builds again after stamping.
 */
async function runForcedTests(dryRun, forceTests) {
	if (!forceTests) return;
	if (dryRun) {
		dryRunLog(
			`npm run clean, npm run build, then the CI=1 test suite with coding-agent in ${FORCED_CODING_AGENT_SHARDS} parallel shards (--force-tests), before stamping`,
		);
		return;
	}
	runClean(false);
	runBuild(false);
	// Run with CI=1 so packages reproduce their CI test behavior — notably the coding-agent vitest suite caps its
	// fork pool (see packages/coding-agent/vitest.config.ts). App code never branches on CI.
	log(
		`CI=1 test suite, coding-agent in ${FORCED_CODING_AGENT_SHARDS} parallel shards (budget ${FORCED_TEST_SUITE_TIMEOUT_MS / 60_000} min)`,
	);
	await runForcedTestSuite();
}

/**
 * Refuse a version the shipped update checker cannot order (senpi#5406). A subprocess, so after a pinned `--sha`
 * checkout it loads the pinned tree's `version-check.ts`, the checker this release actually ships.
 */
function assertShippedCheckerOrders(version) {
	try {
		const guard = fileURLToPath(new URL("./release-version-guard.mjs", import.meta.url));
		execFileSync(process.execPath, [guard, version], { stdio: ["ignore", "ignore", "inherit"] });
	} catch {
		process.stderr.write(`[release] error: refusing to cut ${version}: the shipped update checker cannot order it\n`);
		process.exit(1);
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		printUsage();
		process.exit(0);
	}

	// Inside GitHub Actions a live release runs only from refs/heads/main (senpi#6645), whatever the workflow allowed.
	assertLiveRunOnMain({ dryRun: args.dryRun, env: process.env, what: "the release" });
	// Then, before any build, suite, tag or push: a name npm does not know stops the publish half-way (senpi#6636).
	assertRegistryPackagesKnown();
	log("every publish-set package is known to the npm registry");

	const capture = (bin, cmdArgs) => captureCommand(bin, cmdArgs);
	if (args.testedSha !== null) {
		// The forced-suite matrix jobs tested this commit and the release job checked it out (senpi#6642).
		verifyTestedRelease({ sha: args.sha, testedSha: args.testedSha, shardResults: args.shardResults });
	} else if (args.sha !== null) {
		const driftPaths = ["packages/ai/src/models.generated.ts", "package-lock.json"];
		preparePinnedRelease({
			sha: args.sha,
			dryRun: args.dryRun,
			runCommand,
			capture,
			build: () => runBuild(false),
			driftPaths,
			log,
			dryRunLog,
		});
	}
	preflight(args.dryRun);

	const version = resolveVersion(args);
	assertShippedCheckerOrders(version);
	const date = todayISO();
	log(`target version: v${version}`);
	log(`release date: ${date}`);
	if (args.dryRun) {
		dryRunLog("preview mode; no files, commits, tags, or npm state will be modified");
	}

	if (args.testedSha === null) {
		secureCiEvidence(version, args.dryRun, args.forceTests, args.sha);
		await runForcedTests(args.dryRun, args.forceTests);
	}
	applyWorkspaceVersions(version, args.dryRun, log, dryRunLog);
	runSyncVersions(args.dryRun, runCommand, log, dryRunLog);
	runPackageLockRefresh(args.dryRun, runCommand, log, dryRunLog);
	runClaudeCodeModelSupportReport(args.dryRun, runCommand, log, dryRunLog);
	runInstallLock(args.dryRun, runCommand, log, dryRunLog);
	// Compile only at the cut, on the pinned tree when --sha is set (senpi#3610).
	compileFragments({ dryRun: args.dryRun, log });
	stampChangelogs(version, date, args.dryRun, capturedChangelogSubsections, log, dryRunLog);
	runCheck(args.dryRun);
	runClean(args.dryRun);
	runBuild(args.dryRun);

	stageChangedFiles(args.dryRun);
	gitCommit(`release: v${version}`, args.dryRun);
	gitTag(version, args.dryRun);

	reAddUnreleasedSections(version, date, args.dryRun, capturedChangelogSubsections, log, dryRunLog);
	stageChangedFiles(args.dryRun);
	gitCommit("Add [Unreleased] section for next cycle", args.dryRun);

	if (args.sha !== null) {
		const files = {
			readFile: (file) => readFileSync(file, "utf-8"),
			writeFile: (file, text) => writeFileSync(file, text),
		};
		syncPinnedReleaseIntoMain({
			pinnedSha: args.sha,
			version,
			changelogs: CHANGELOGS,
			dryRun: args.dryRun,
			runCommand,
			capture,
			log,
			dryRunLog,
			...files,
		});
	} else syncRemoteMainBeforePush(args.dryRun, runCommand, log, dryRunLog);
	gitPush("main", args.dryRun);
	gitPush(`v${version}`, args.dryRun);

	if (args.dryRun) {
		log(`dry-run complete; would have prepared v${version}`);
	} else {
		log(
			`prepared v${version}; publish with: gh workflow run publish-npm.yml -f version=${version} -f publish-only=true`,
		);
	}
}

try {
	await main();
} catch (err) {
	process.stderr.write(`[release] error: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exitCode = 1;
}
