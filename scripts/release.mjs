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
 * Flow (matches AGENTS.md "VERSIONING & UPSTREAM SYNC"):
 *   1. Pre-flight: branch must be `main`; working tree must be clean (--dry-run warns
 *      and continues so the preview is usable during development).
 *   2. Resolve version: `--version` override or `computeNextVersion()` from calver.mjs.
 *   3. Write `version` into all 5 workspace package.json files directly (TAB indent,
 *      trailing newline). `npm version` is intentionally NOT used; the `-N` suffix on
 *      same-day re-releases looks like a prerelease tag to npm.
 *   4. Run `scripts/sync-versions.js` to propagate the new version to inter-package deps.
 *   5. For each `packages/*\/CHANGELOG.md`, replace `## [Unreleased]` with
 *      `## [<version>] - <YYYY-MM-DD>`, remembering its subsection structure
 *      (`### Added`, `### Fixed`, ...) for re-insertion in step 7.
 *   6. `git add -A`, `git commit -m "release: v<version>"` (husky pre-commit runs),
 *      `git tag v<version>`, then `npm run publish` (publishes to npm with `--tag latest`).
 *   7. Re-insert a fresh `## [Unreleased]` block with the same subsection placeholders,
 *      commit, then push `main` and the new tag.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { computeNextVersion } from "./calver.mjs";

const VERSION_RE = /^\d{4}\.\d{1,2}\.\d{1,2}(-\d+)?$/;

const WORKSPACE_PACKAGES = [
	"packages/ai/package.json",
	"packages/agent/package.json",
	"packages/coding-agent/package.json",
	"packages/tui/package.json",
	"packages/web-ui/package.json",
];

const CHANGELOGS = [
	"packages/ai/CHANGELOG.md",
	"packages/agent/CHANGELOG.md",
	"packages/coding-agent/CHANGELOG.md",
	"packages/tui/CHANGELOG.md",
	"packages/web-ui/CHANGELOG.md",
];

const PUBLIC_PACKAGE_DEPENDENCY_PINS = [
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-tui",
];

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

function writeWorkspaceVersion(file, version, dryRun) {
	const raw = readFileSync(file, "utf-8");
	const pkg = JSON.parse(raw);
	const previous = pkg.version;
	if (previous === version) {
		log(`  ${file}: already ${version}`);
		return;
	}
	if (dryRun) {
		dryRunLog(`write ${file} (version: ${previous} -> ${version})`);
		return;
	}
	// JSON.stringify preserves key insertion order for string keys. Reassigning
	// `version` updates the value in place without moving the key.
	pkg.version = version;
	writeFileSync(file, `${JSON.stringify(pkg, null, "\t")}\n`);
	log(`  ${file}: ${previous} -> ${version}`);
}

function applyWorkspaceVersions(version, dryRun) {
	log(`applying version ${version} to ${WORKSPACE_PACKAGES.length} workspace package.json files`);
	for (const file of WORKSPACE_PACKAGES) {
		writeWorkspaceVersion(file, version, dryRun);
	}
}

function extractUnreleasedSubsections(content) {
	const lines = content.split("\n");
	const start = lines.findIndex((line) => line.trim() === "## [Unreleased]");
	if (start === -1) {
		return null;
	}
	const subsections = [];
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.startsWith("## [")) {
			break;
		}
		if (line.startsWith("### ")) {
			subsections.push(line);
		}
	}
	return subsections;
}

function buildUnreleasedBlock(subsections) {
	let block = "## [Unreleased]\n\n";
	for (const sub of subsections) {
		block += `${sub}\n\n`;
	}
	return block;
}

const capturedSubsections = new Map();

function stampChangelogs(version, date, dryRun) {
	log(`stamping ${CHANGELOGS.length} CHANGELOG.md files: [Unreleased] -> [${version}] - ${date}`);
	for (const file of CHANGELOGS) {
		const content = readFileSync(file, "utf-8");
		const subsections = extractUnreleasedSubsections(content);
		if (subsections === null) {
			log(`  skip ${file}: no [Unreleased] section`);
			continue;
		}
		capturedSubsections.set(file, subsections);
		const updated = content.replace(/^## \[Unreleased\]$/m, `## [${version}] - ${date}`);
		const count = subsections.length;
		const noun = count === 1 ? "subsection header" : "subsection headers";
		if (dryRun) {
			dryRunLog(`write ${file} ([Unreleased] -> [${version}] - ${date}; ${count} ${noun} captured)`);
			continue;
		}
		writeFileSync(file, updated);
		log(`  stamped ${file} (${count} ${noun} captured)`);
	}
}

function reAddUnreleasedSections(version, date, dryRun) {
	log(`re-inserting [Unreleased] block in ${CHANGELOGS.length} CHANGELOG.md files`);
	for (const file of CHANGELOGS) {
		const subsections = capturedSubsections.get(file);
		if (subsections === undefined) {
			log(`  skip ${file}: no [Unreleased] section was captured`);
			continue;
		}
		const block = buildUnreleasedBlock(subsections);
		const count = subsections.length;
		const noun = count === 1 ? "placeholder" : "placeholders";
		if (dryRun) {
			dryRunLog(
				`insert [Unreleased] block before [${version}] - ${date} in ${file} (${count} ${noun})`,
			);
			continue;
		}
		const content = readFileSync(file, "utf-8");
		const target = `## [${version}] - ${date}`;
		const updated = content.replace(target, () => `${block}${target}`);
		writeFileSync(file, updated);
		log(`  re-added [Unreleased] to ${file}`);
	}
}

function runSyncVersions(dryRun) {
	if (dryRun) {
		dryRunLog("node scripts/sync-versions.js");
		return;
	}
	log("running scripts/sync-versions.js");
	runCommand("node", ["scripts/sync-versions.js"]);
}

function getPublishedVersion(packageName) {
	return captureCommand("npm", ["view", packageName, "version"]).trim();
}

function pinPublicPackageDependencies(dryRun) {
	const file = "packages/coding-agent/package.json";
	const raw = readFileSync(file, "utf-8");
	const pkg = JSON.parse(raw);
	const updates = [];

	for (const depName of PUBLIC_PACKAGE_DEPENDENCY_PINS) {
		const publishedVersion = getPublishedVersion(depName);
		const newRange = `^${publishedVersion}`;
		const currentRange = pkg.dependencies?.[depName];
		if (currentRange !== newRange) {
			updates.push({ depName, currentRange, newRange });
			if (!dryRun) {
				pkg.dependencies[depName] = newRange;
			}
		}
	}

	if (updates.length === 0) {
		log("public package dependencies already point at published npm versions");
		return;
	}

	log("pinning public package dependencies to published npm versions");
	for (const update of updates) {
		const previous = update.currentRange ?? "<missing>";
		const message = `  ${update.depName}: ${previous} -> ${update.newRange}`;
		if (dryRun) {
			dryRunLog(message);
		} else {
			log(message);
		}
	}

	if (!dryRun) {
		writeFileSync(file, `${JSON.stringify(pkg, null, "\t")}\n`);
	}
}

function gitAddAll(dryRun) {
	if (dryRun) {
		dryRunLog("git add -A");
		return;
	}
	log("git add -A");
	runCommand("git", ["add", "-A"]);
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

function runPublish(dryRun) {
	if (dryRun) {
		dryRunLog("npm run publish");
		return;
	}
	log("npm run publish");
	runCommand("npm", ["run", "publish"]);
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

	applyWorkspaceVersions(version, args.dryRun);
	runSyncVersions(args.dryRun);
	pinPublicPackageDependencies(args.dryRun);
	stampChangelogs(version, date, args.dryRun);

	gitAddAll(args.dryRun);
	gitCommit(`release: v${version}`, args.dryRun);
	gitTag(version, args.dryRun);

	runPublish(args.dryRun);

	reAddUnreleasedSections(version, date, args.dryRun);
	gitAddAll(args.dryRun);
	gitCommit("Add [Unreleased] section for next cycle", args.dryRun);

	gitPush("main", args.dryRun);
	gitPush(`v${version}`, args.dryRun);

	if (args.dryRun) {
		log(`dry-run complete; would have published v${version}`);
	} else {
		log(`published v${version}`);
	}
}

main();
