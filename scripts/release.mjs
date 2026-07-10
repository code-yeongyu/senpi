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
 *   3. Write `version` into all release workspace package.json files directly (TAB indent,
 *      trailing newline). `npm version` is intentionally NOT used; the `-N` suffix on
 *      same-day re-releases looks like a prerelease tag to npm.
 *   4. Run `scripts/sync-versions.js` to propagate the new version to source
 *      inter-package deps, then refresh `package-lock.json`.
 *   5. Regenerate AI model artifacts and `packages/coding-agent/publish-deps.lock.json`.
 *   6. For each `packages/*\/CHANGELOG.md`, replace `## [Unreleased]` with
 *      `## [<version>] - <YYYY-MM-DD>`, remembering its subsection structure
 *      (`### Added`, `### Fixed`, ...) for re-insertion in step 8.
 *   7. Run `npm run check` and `npm test`.
 *   8. Commit the release, tag it, re-insert a fresh `## [Unreleased]` block,
 *      commit the next-cycle changelog update, then push `main` and the new tag.
 *      GitHub Actions builds binaries and publishes from the pushed tag.
 */

import { execFileSync } from "node:child_process";
import { computeNextVersion } from "./calver.mjs";
import {
	runGenerateImageModels,
	runGenerateModels,
	runInstallLock,
	runPackageLockRefresh,
	runShrinkwrap,
} from "./release-artifacts.mjs";
import { reAddUnreleasedSections, stampChangelogs } from "./release-changelog.mjs";
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
		"  --help, -h      Show this help and exit.",
		"",
		"Default flow: compute next version via scripts/calver.mjs, then release.",
	].join("\n");
	process.stdout.write(`${text}\n`);
}

function parseArgs(argv) {
	const args = { dryRun: false, version: null, help: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			args.help = true;
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

function runCommand(bin, args) {
	try {
		execFileSync(bin, args, { stdio: "inherit" });
	} catch (err) {
		const message = err && typeof err === "object" && "message" in err ? err.message : String(err);
		process.stderr.write(`[release] error: ${bin} ${args.join(" ")} failed: ${message}\n`);
		process.exit(1);
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

function runTests(dryRun) {
	if (dryRun) {
		dryRunLog("npm test");
		return;
	}
	log("npm test");
	runCommand("npm", ["test"]);
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

	applyWorkspaceVersions(version, args.dryRun, log, dryRunLog);
	runSyncVersions(args.dryRun, runCommand, log, dryRunLog);
	runPackageLockRefresh(args.dryRun, runCommand, log, dryRunLog);
	runGenerateModels(args.dryRun, runCommand, log, dryRunLog);
	runGenerateImageModels(args.dryRun, runCommand, log, dryRunLog);
	runShrinkwrap(args.dryRun, runCommand, log, dryRunLog);
	runInstallLock(args.dryRun, runCommand, log, dryRunLog);
	stampChangelogs(version, date, args.dryRun, capturedChangelogSubsections, log, dryRunLog);
	runCheck(args.dryRun);
	runTests(args.dryRun);

	stageChangedFiles(args.dryRun);
	gitCommit(`release: v${version}`, args.dryRun);
	gitTag(version, args.dryRun);

	reAddUnreleasedSections(version, date, args.dryRun, capturedChangelogSubsections, log, dryRunLog);
	stageChangedFiles(args.dryRun);
	gitCommit("Add [Unreleased] section for next cycle", args.dryRun);

	gitPush("main", args.dryRun);
	gitPush(`v${version}`, args.dryRun);

	if (args.dryRun) {
		log(`dry-run complete; would have prepared v${version}`);
	} else {
		log(`prepared v${version}; CI publishing starts after the tag push`);
	}
}

main();
