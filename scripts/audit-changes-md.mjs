#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
	auditChangesMdCoverage,
	isProductionPath,
	parseTrackerEntries,
	UPSTREAM_PIN_PATH,
} from "./changes-md-policy.mjs";
import {
	ensureCommitExists,
	filesInCommit,
	listTrackerFiles,
	parseNameStatus,
	readUpstreamPin,
	runGit,
} from "./changes-md-git.mjs";

/** Direct tree comparison (pin vs HEAD) with rename-aware change kinds. */
function resolveRangeNameStatus(from, to) {
	const what = `git diff --name-status -M ${from} ${to}`;
	return parseNameStatus(runGit(["diff", "--name-status", "-M", from, to], what));
}

/**
 * Audits HEAD against the pinned upstream SHA: every production path that
 * diverged from the pin (added, modified, renamed, or deleted) must be covered
 * by an entry with all four canonical sections in its exact nearest changes.md
 * tracker. Fork-only paths (absent from the pin tree) are exempt.
 */
function buildAuditReport(upstreamPath) {
	const pin = readUpstreamPin(upstreamPath);
	ensureCommitExists(pin.sha);
	const { changedFiles, renames, deletions } = resolveRangeNameStatus(pin.sha, "HEAD");
	const upstreamTree = filesInCommit(pin.sha);
	const upstreamRenames = renames.filter((rename) => upstreamTree.has(rename.from));
	const upstreamRenameTargets = new Set(upstreamRenames.map((rename) => rename.to));
	const forkOnly = changedFiles.filter((path) => !upstreamTree.has(path) && !upstreamRenameTargets.has(path));
	const trackerDiffs = {};
	const existingTrackers = listTrackerFiles(".");
	for (const tracker of existingTrackers) {
		const entries = parseTrackerEntries(readFileSync(tracker, "utf8"), tracker);
		if (entries.length > 0) {
			trackerDiffs[tracker] = entries;
		}
	}
	const divergentFiles = changedFiles.filter(isProductionPath);
	const trackerPolicy = {
		forkOnly,
		trackerDiffs,
		existingTrackers,
		renames: upstreamRenames,
		deletions,
		upstreamSync: { pinChanged: true, divergentFiles },
	};
	const { covered, uncovered } = auditChangesMdCoverage({ changedFiles, trackerPolicy });
	return {
		baseline: { upstream: pin.repo, tag: pin.tag, pin: pin.sha, auditedRef: "HEAD" },
		counts: {
			divergent: divergentFiles.length,
			audited: covered.length + uncovered.length,
			covered: covered.length,
			uncovered: uncovered.length,
		},
		covered,
		uncovered,
	};
}

function renderJson(report) {
	return JSON.stringify(report, null, 2);
}

function renderMarkdown(report) {
	const lines = [
		"# changes.md repository audit",
		"",
		`- Upstream: ${report.baseline.upstream}`,
		`- Pin: ${report.baseline.pin} (${report.baseline.tag})`,
		`- Audited: ${report.counts.audited} production path(s), ${report.counts.covered} covered, ${report.counts.uncovered} uncovered`,
	];
	if (report.uncovered.length === 0) {
		lines.push("", "No uncovered production paths. Every divergence from the pin is tracked.");
	}
	for (const item of report.uncovered) {
		const tracker = item.nearestTracker ?? "(no nearest tracker)";
		lines.push(`- ${item.path} - ${item.reason} - nearest: ${tracker}`);
	}
	for (const item of report.covered) {
		lines.push(`- ${item.path} - covered by ${item.tracker}`);
	}
	return lines.join("\n");
}

function printUsage() {
	console.log("usage: node scripts/audit-changes-md.mjs [--upstream <path>] [--format json|markdown] [--help]");
	console.log("");
	console.log("Audits every production path that diverged from the pinned upstream commit against");
	console.log("its exact nearest changes.md tracker. Exits 0 when nothing is uncovered, 1 when any");
	console.log("path is uncovered, and 2 on malformed upstream metadata or a missing pinned commit.");
	console.log(`Defaults: --upstream ${UPSTREAM_PIN_PATH} --format markdown`);
}

function parseArgs(argv) {
	const args = { upstream: UPSTREAM_PIN_PATH, format: "markdown" };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--upstream") {
			args.upstream = argv[index + 1];
			index += 1;
		} else if (arg === "--format") {
			args.format = argv[index + 1];
			index += 1;
		} else {
			throw new Error(`unknown argument: ${arg}`);
		}
	}
	if (args.upstream === undefined) {
		throw new Error("--upstream requires a path");
	}
	if (args.format !== "json" && args.format !== "markdown") {
		throw new Error(`unknown format: ${args.format} (expected json or markdown)`);
	}
	return args;
}

function main(argv) {
	if (argv.includes("--help") || argv.includes("-h")) {
		printUsage();
		return 0;
	}
	let args;
	try {
		args = parseArgs(argv);
	} catch (error) {
		console.error(`changes-md-audit: ERROR - ${error.message}`);
		printUsage();
		return 2;
	}
	let report;
	try {
		report = buildAuditReport(args.upstream);
	} catch (error) {
		console.error(`changes-md-audit: ERROR - ${error.message}`);
		return 2;
	}
	console.log(args.format === "json" ? renderJson(report) : renderMarkdown(report));
	return report.counts.uncovered > 0 ? 1 : 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	process.exit(main(process.argv.slice(2)));
}
