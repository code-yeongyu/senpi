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
 *      provider defaults against it. If the catalog changed, commit it alone and push it to
 *      `main`, so CI tests exactly the tree the release ships. Then wait for that commit's
 *      green "Check and test" run, the fan-in of every CI shard and required job. A red run
 *      stops the release; a run superseded by a newer `main` push moves the release onto
 *      that commit. The suite is never re-run here unless `--force-tests` asks for it.
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
import { computeNextVersion } from "./calver.mjs";
import { syncRemoteMainBeforePush } from "./release-git.mjs";
import {
	runClaudeCodeModelSupportReport,
	runGenerateModels,
	runProviderDefaultsCheck,
	runInstallLock,
	runPackageLockRefresh,
} from "./release-artifacts.mjs";
import { reAddUnreleasedSections, stampChangelogs } from "./release-changelog.mjs";
import {
	awaitCiEvidence,
	catalogChangedSinceHead,
	discardTimestampOnlyCatalogChange,
	planCiEvidence,
	REGENERATED_CATALOG_PATHS,
	REQUIRED_CHECK_NAME,
} from "./release-test-gate.mjs";
import { applyWorkspaceVersions, runSyncVersions } from "./release-packages.mjs";

const VERSION_RE = /^\d{4}\.\d{1,2}\.\d{1,2}(-\d+)?$/;

function printUsage() {
	const text = [
		"Usage: node scripts/release.mjs [options]",
		"",
		"Releases the senpi monorepo using CalVer (YYYY.M.D or YYYY.M.D-N).",
		"",
		"Options:",
		"  --version <v>   Explicit CalVer version. Must match",
		"                  /^\\d{4}\\.\\d{1,2}\\.\\d{1,2}(-\\d+)?$/ — for example 2026.5.13",
		"                  or 2026.5.13-2.",
		"  --dry-run       Preview every shell command and file write; modify nothing.",
		"                  Read-only git/npm reads (status, branch, tag --list,",
		"                  npm view) still execute so the plan is accurate.",
		"  --force-tests   Run the CI=1 npm test suite in this job instead of",
		"                  reusing the release commit's green \"Check and test\" CI run.",
		"  --help, -h      Show this help and exit.",
		"",
		"Default flow: compute next version via scripts/calver.mjs, then release.",
	].join("\n");
	process.stdout.write(`${text}\n`);
}

function parseArgs(argv) {
	const args = { dryRun: false, version: null, help: false, forceTests: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			args.help = true;
		} else if (arg === "--force-tests") {
			args.forceTests = true;
		} else if (arg === "--dry-run") {
			args.dryRun = true;
		} else if (arg === "--version") {
			i += 1;
			if (i >= argv.length) {
				process.stderr.write("[release] error: --version requires an argument\n");
				process.exit(1);
			}
			args.version = argv[i];
		} else {
			process.stderr.write(`[release] error: unknown argument: ${arg}\n`);
			process.exit(1);
		}
	}
	return args;
}

function log(message) {
	process.stdout.write(`[release] ${message}\n`);
}

function dryRunLog(message) {
	process.stdout.write(`[dry-run] ${message}\n`);
}

function captureCommand(bin, args) {
	try {
		return execFileSync(bin, args, {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err) {
		const message = err && typeof err === "object" && "message" in err ? err.message : String(err);
		process.stderr.write(`[release] error: ${bin} ${args.join(" ")} failed: ${message}\n`);
		process.exit(1);
	}
}

function runCommand(bin, args, extraEnv) {
	try {
		execFileSync(bin, args, extraEnv ? { stdio: "inherit", env: { ...process.env, ...extraEnv } } : { stdio: "inherit" });
	} catch (err) {
		const message = err && typeof err === "object" && "message" in err ? err.message : String(err);
		throw new Error(`${bin} ${args.join(" ")} failed: ${message}`, { cause: err });
	}
}

function preflight(dryRun) {
	const branch = captureCommand("git", ["branch", "--show-current"]).trim();
	if (branch !== "main") {
		process.stderr.write(
			`[release] error: must be on main branch, currently on "${branch || "<detached>"}"\n`,
		);
		process.exit(1);
	}
	log("on branch main");

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
				`[release] error: invalid --version "${opts.version}" ` +
					"(expected YYYY.M.D or YYYY.M.D-N)\n",
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

function stageChangedFiles(dryRun) {
	if (dryRun) {
		dryRunLog("git add -- <changed files>");
		return;
	}
	const output = captureCommand("git", ["ls-files", "-m", "-o", "-d", "--exclude-standard"]);
	const paths = [...new Set(output.split("\n").map((line) => line.trim()).filter(Boolean))];
	if (paths.length === 0) {
		log("no changed files to stage");
		return;
	}
	log(`git add ${paths.length} changed file(s)`);
	runCommand("git", ["add", "--", ...paths]);
}

function gitCommit(message, dryRun) {
	if (dryRun) {
		dryRunLog(`git commit -m ${JSON.stringify(message)}`);
		return;
	}
	log(`git commit -m ${JSON.stringify(message)}`);
	runCommand("git", ["commit", "-m", message]);
}

function gitTag(version, dryRun) {
	const tag = `v${version}`;
	if (dryRun) {
		dryRunLog(`git tag ${tag}`);
		return;
	}
	log(`git tag ${tag}`);
	runCommand("git", ["tag", tag]);
}

function gitPush(refspec, dryRun) {
	if (dryRun) {
		dryRunLog(`git push origin ${refspec}`);
		return;
	}
	log(`git push origin ${refspec}`);
	runCommand("git", ["push", "origin", refspec]);
}

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

function lookupCiCheckRuns(sha) {
	try {
		const raw = execFileSync(
			"gh",
			["api", `repos/{owner}/{repo}/commits/${sha}/check-runs`, "--paginate", "--slurp"],
			{ encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
		);
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
	const raw = execFileSync("gh", ["api", `repos/{owner}/{repo}/actions/runs?check_suite_id=${checkSuiteId}&per_page=1`], {
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
	});
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
 * A regenerated model catalog is committed and pushed to main on its own first, so CI tests exactly the tree the
 * release ships (the gap behind senpi#2645); then the release waits for that commit's green "Check and test".
 */
function secureCiEvidence(version, dryRun, forceTests) {
	runGenerateModels(dryRun, runCommand, log, dryRunLog);
	runProviderDefaultsCheck(dryRun, runCommand, log, dryRunLog);
	if (dryRun) {
		dryRunLog(`if the catalog changed: git commit ${REGENERATED_CATALOG_PATHS.join(" ")} and git push origin main`);
		const sha = captureCommand("git", ["rev-parse", "HEAD"]).trim();
		const plan = planCiEvidence({ sha, checkRuns: lookupCiCheckRuns(sha) });
		dryRunLog(`test gate (preview, HEAD): ${plan.reason}`);
		dryRunLog(forceTests ? "CI=1 npm test (--force-tests)" : 'wait for the release commit\'s green "Check and test"');
		return;
	}
	if (discardTimestampOnlyCatalogChange(process.cwd())) {
		log("the regeneration changed only the catalog manifest's generatedAt stamp; keeping HEAD's catalog");
	}
	if (catalogChangedSinceHead(process.cwd())) {
		log("the regeneration changed the model catalog; committing it to main so CI tests the tree this release ships");
		runCommand("git", ["add", "--", ...REGENERATED_CATALOG_PATHS]);
		gitCommit(`chore(ai): regenerate the model catalog for v${version}`, false);
		syncRemoteMainBeforePush(false, runCommand, log, dryRunLog);
		gitPush("main", false);
	}
	if (forceTests) {
		log("test gate: --force-tests given; the suite runs in this job after the build");
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
		},
	);
}

function runForcedTests(dryRun, forceTests) {
	if (!forceTests || dryRun) return;
	// Run with CI=1 so packages reproduce their CI test behavior — notably the coding-agent vitest suite serializes
	// its subprocess-heavy tests to a single fork (see packages/coding-agent/vitest.config.ts). App code never
	// branches on CI.
	log("CI=1 npm test");
	runCommand("npm", ["test"], { CI: "1" });
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help) {
		printUsage();
		process.exit(0);
	}

	preflight(args.dryRun);

	const version = resolveVersion(args);
	const date = todayISO();
	log(`target version: v${version}`);
	log(`release date: ${date}`);
	if (args.dryRun) {
		dryRunLog("preview mode; no files, commits, tags, or npm state will be modified");
	}

	secureCiEvidence(version, args.dryRun, args.forceTests);
	applyWorkspaceVersions(version, args.dryRun, log, dryRunLog);
	runSyncVersions(args.dryRun, runCommand, log, dryRunLog);
	runPackageLockRefresh(args.dryRun, runCommand, log, dryRunLog);
	runClaudeCodeModelSupportReport(args.dryRun, runCommand, log, dryRunLog);
	runInstallLock(args.dryRun, runCommand, log, dryRunLog);
	stampChangelogs(version, date, args.dryRun, capturedChangelogSubsections, log, dryRunLog);
	runCheck(args.dryRun);
	runClean(args.dryRun);
	runBuild(args.dryRun);
	runForcedTests(args.dryRun, args.forceTests);

	stageChangedFiles(args.dryRun);
	gitCommit(`release: v${version}`, args.dryRun);
	gitTag(version, args.dryRun);

	reAddUnreleasedSections(version, date, args.dryRun, capturedChangelogSubsections, log, dryRunLog);
	stageChangedFiles(args.dryRun);
	gitCommit("Add [Unreleased] section for next cycle", args.dryRun);

	syncRemoteMainBeforePush(args.dryRun, runCommand, log, dryRunLog);
	gitPush("main", args.dryRun);
	gitPush(`v${version}`, args.dryRun);

	if (args.dryRun) {
		log(`dry-run complete; would have prepared v${version}`);
	} else {
		log(`prepared v${version}; publish with: gh workflow run publish-npm.yml -f version=${version} -f publish-only=true`);
	}
}

try {
	main();
} catch (err) {
	process.stderr.write(`[release] error: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exitCode = 1;
}
