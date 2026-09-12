#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
	auditChangesMdCoverage,
	isProductionPath,
	isRuntimeSourceChange,
	parseTrackerEntries,
	restrictTrackerEntriesToAddedLines,
	summarizeUncovered,
	UPSTREAM_PIN_PATH,
} from "./changes-md-policy.mjs";
import {
	ensureCommitExists,
	filesInCommit,
	listTrackerFiles,
	readUpstreamPin,
	resolvePrNameStatus,
	runGit,
	validateGitRevision,
} from "./changes-md-git.mjs";

export { restrictTrackerEntriesToAddedLines, validateGitRevision };

const CHANGELOG_PATTERN = /(^|\/)CHANGELOG\.md$/i;
const NO_CHANGELOG_LABEL = "no-changelog";

export { isRuntimeSourceChange };

function isChangelogChange(path) {
	return CHANGELOG_PATTERN.test(path);
}

export function checkPrChangelog({ changedFiles, labels, trackerPolicy }) {
	const normalizedLabels = (labels ?? []).map((label) => label.trim()).filter(Boolean);
	const hasNoChangelogLabel = normalizedLabels.includes(NO_CHANGELOG_LABEL);
	const changelogFiles = changedFiles.filter(isChangelogChange);
	const runtimeFiles = changedFiles.filter(isRuntimeSourceChange);

	// Release CHANGELOG.md verdict: unchanged legacy semantics. The
	// `no-changelog` label bypasses only this requirement, never changes.md.
	let releasePass;
	let releaseReason;
	if (runtimeFiles.length === 0) {
		releasePass = true;
		releaseReason = "no runtime source changes detected";
	} else if (changelogFiles.length > 0) {
		releasePass = true;
		releaseReason = `changelog entry updated (${changelogFiles.join(", ")})`;
	} else if (hasNoChangelogLabel) {
		releasePass = true;
		releaseReason = `'${NO_CHANGELOG_LABEL}' label present`;
	} else {
		releasePass = false;
		releaseReason = "runtime source changed without a CHANGELOG.md entry";
	}

	// Tracker verdict: only when a trackerPolicy input is supplied. It is
	// independent from the release changelog verdict; an uncovered path fails
	// regardless of labels, while complete tracker coverage cannot replace a
	// required package CHANGELOG.md entry.
	const audit = trackerPolicy == null ? null : auditChangesMdCoverage({ changedFiles, trackerPolicy });
	const uncovered = audit ? audit.uncovered.map((item) => item.path) : [];
	let pass;
	let reason;
	if (audit && uncovered.length > 0) {
		pass = false;
		reason = summarizeUncovered(audit.uncovered);
	} else if (audit) {
		const coverageReason = `changes.md coverage complete (${audit.covered.length} production path(s) covered)`;
		pass = releasePass;
		reason = releasePass ? `${coverageReason}; ${releaseReason}` : `${releaseReason}; ${coverageReason}`;
	} else {
		pass = releasePass;
		reason = releaseReason;
	}

	return { pass, reason, runtimeFiles, changelogFiles, hasNoChangelogLabel, uncovered };
}

function diffPathsBetween(from, to) {
	const what = `git diff --name-only ${from} ${to}`;
	return runGit(["diff", "--name-only", from, to], what)
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function addedDiffLines(base, path) {
	const what = `git diff ${base}...HEAD -- ${path}`;
	const text = runGit(["diff", `${base}...HEAD`, "--", path], what);
	return new Set(
		text
			.split("\n")
			.filter((line) => line.startsWith("+") && !line.startsWith("+++"))
			.map((line) => line.slice(1).trim()),
	);
}

/**
 * Collects the tracker policy for a real PR: reads the upstream pin (fails
 * closed on malformed metadata or a missing pinned commit), derives rename-aware
 * changed paths, separates fork-only paths from upstream-owned ones via the pin
 * tree, measures HEAD divergence from the new pin on pin-changing syncs, and
 * parses every tracker the PR touched into coverage entries.
 */
function collectPrFacts(base) {
	const pin = readUpstreamPin(UPSTREAM_PIN_PATH);
	ensureCommitExists(pin.sha);
	const { changedFiles, renames, deletions } = resolvePrNameStatus(base);
	const pinChanged = changedFiles.includes(UPSTREAM_PIN_PATH);
	const upstreamTree = filesInCommit(pin.sha);
	const upstreamRenames = renames.filter((rename) => upstreamTree.has(rename.from));
	const upstreamRenameTargets = new Set(upstreamRenames.map((rename) => rename.to));
	const forkOnly = changedFiles.filter(
		(path) => isProductionPath(path) && !upstreamTree.has(path) && !upstreamRenameTargets.has(path),
	);
	const divergentFiles = pinChanged ? diffPathsBetween(pin.sha, "HEAD").filter(isProductionPath) : [];
	const trackerDiffs = {};
	const existingTrackers = listTrackerFiles(".");
	for (const tracker of existingTrackers) {
		if (!changedFiles.includes(tracker)) continue;
		const added = addedDiffLines(base, tracker);
		const touched = restrictTrackerEntriesToAddedLines(
			parseTrackerEntries(readFileSync(tracker, "utf8"), tracker),
			added,
			tracker,
		);
		if (touched.length > 0) trackerDiffs[tracker] = touched;
	}
	return {
		changedFiles,
		trackerPolicy: {
			forkOnly,
			trackerDiffs,
			existingTrackers,
			renames: upstreamRenames,
			deletions,
			upstreamSync: pinChanged ? { pinChanged: true, divergentFiles } : undefined,
		},
	};
}

function printUsage() {
	console.log("usage: node scripts/check-pr-changelog.mjs --base <sha> [--labels a,b,c] [--help]");
	console.log("");
	console.log("Checks the PR for a CHANGELOG.md [Unreleased] entry (or the 'no-changelog'");
	console.log("label) and for coverage of every upstream-owned production change in its exact");
	console.log("nearest changes.md tracker, with all four canonical sections. Exits 0 when");
	console.log("both policies pass, 1 on failure or malformed upstream metadata.");
}

export function parseArgs(argv, env = process.env) {
	const args = { labels: [] };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--base") {
			args.base = argv[index + 1];
			index += 1;
		} else if (arg === "--labels") {
			args.labels = (argv[index + 1] ?? "")
				.split(",")
				.map((label) => label.trim())
				.filter(Boolean);
			index += 1;
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	if (!args.base && typeof env.CHANGELOG_GATE_BASE === "string" && env.CHANGELOG_GATE_BASE.trim()) {
		args.base = env.CHANGELOG_GATE_BASE.trim();
	}
	if (args.labels.length === 0 && typeof env.CHANGELOG_GATE_LABELS === "string") {
		args.labels = env.CHANGELOG_GATE_LABELS.split(",")
			.map((label) => label.trim())
			.filter(Boolean);
	}
	if (!args.base) throw new Error("missing required --base <sha> argument");
	args.base = validateGitRevision(args.base);
	return args;
}

export function main(argv) {
	if (argv.includes("--help") || argv.includes("-h")) {
		printUsage();
		return 0;
	}
	let args;
	try {
		args = parseArgs(argv);
	} catch (error) {
		console.error(`changelog-gate: ERROR - ${error.message}`);
		printUsage();
		return 1;
	}

	let changedFiles;
	let trackerPolicy;
	try {
		const facts = collectPrFacts(args.base);
		changedFiles = facts.changedFiles;
		trackerPolicy = facts.trackerPolicy;
	} catch (error) {
		console.error(`changelog-gate: ERROR - ${error.message}`);
		return 1;
	}

	const result = checkPrChangelog({ changedFiles, labels: args.labels, trackerPolicy });
	const verdict = result.pass ? "PASS" : "FAIL";
	console.log(`changelog-gate: ${verdict} - ${result.reason}`);
	if (!result.pass) {
		for (const file of result.runtimeFiles) {
			console.log(`  runtime change: ${file}`);
		}
		for (const path of result.uncovered) {
			console.log(`  missing changes.md coverage: ${path}`);
		}
		console.log(
			"Add an entry under ## [Unreleased] in the affected package CHANGELOG.md, " +
				`apply the '${NO_CHANGELOG_LABEL}' label if this change is not user-facing, ` +
				"or cover the change in its exact nearest changes.md tracker.",
		);
	}
	return result.pass ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	process.exit(main(process.argv.slice(2)));
}
