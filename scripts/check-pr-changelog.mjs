#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import {
	auditChangesMdCoverage,
	isRuntimeSourceChange,
	restrictTrackerEntriesToAddedLines,
	summarizeUncovered,
} from "./changes-md-policy.mjs";
import { validateGitRevision } from "./changes-md-git.mjs";

import { changelogSections, collectPrFacts, isChangelogChange } from "./check-pr-changelog-facts.mjs";

export { restrictTrackerEntriesToAddedLines, validateGitRevision };

const NO_CHANGELOG_LABEL = "no-changelog";

export { isRuntimeSourceChange };

function releasedChangelogViolations({ path, before, after, taggedSections = {} }) {
	const [previous, current] = [before, after].map(changelogSections);
	const violations = [];
	for (let index = 1; index < current.length; index += 1) {
		if (current[index].name === "Unreleased")
			violations.push(`${path}:${current[index].line}: released section [${current[index - 1].name}] interrupted`);
	}
	const oldReleased = previous.filter((section) => section.name !== "Unreleased");
	const newReleased = current.filter((section) => section.name !== "Unreleased");
	const unreleased = previous.find((section) => section.name === "Unreleased");
	// Release tooling renames the existing Unreleased block, then inserts an empty next cycle.
	if (
		newReleased.length === oldReleased.length + 1 &&
		unreleased?.body === newReleased[0]?.body &&
		!oldReleased.some((section) => section.name === newReleased[0].name)
	) newReleased.shift();
	for (let index = 0; index < Math.max(oldReleased.length, newReleased.length); index += 1) {
		const oldSection = oldReleased[index];
		const newSection = newReleased[index];
		if (oldSection?.text === newSection?.text) continue;
		if (newSection && oldSection?.name === newSection.name && newSection.text === taggedSections[newSection.name]) continue;
		const oldLines = oldSection?.text.split("\n") ?? [];
		const newLines = newSection?.text.split("\n") ?? [];
		let offset = 0;
		while (offset < Math.min(oldLines.length, newLines.length) && oldLines[offset] === newLines[offset]) offset += 1;
		const section = newSection ?? oldSection;
		violations.push(`${path}:${section.line + offset}: released section [${section.name}] changed`);
	}
	return violations;
}

const UNRELEASED_SECTION = /^## \[Unreleased\][^\n]*\n([\s\S]*?)(?=^## \[|(?![\s\S]))/m;

function unreleasedBullets(text) {
	const section = UNRELEASED_SECTION.exec(text);
	if (!section) return [];
	return section[1]
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("- ") || line.startsWith("* "));
}

// Issue and PR numbers a bullet cites, from `#123` and from `/issues/123` or `/pull/123` links.
function bulletReferences(line) {
	return new Set([...line.matchAll(/(?:#|\/(?:issues|pull)\/)(\d+)/g)].map((match) => match[1]));
}

// An [Unreleased] bullet may be edited in place (a credit, a wording fix) or carried into a released section
// by release stamping. A base bullet still present anywhere in the head is kept. A base bullet that is gone
// is accepted only as edited, one for one, by a new [Unreleased] bullet that either cites every issue/PR it
// cited (a credit or a reword keeps those) or starts with its full text (a credit or link appended to a bullet
// that cited nothing). Anything else is a removal, including deleting another PR's bullet while adding this
// PR's own; a bullet that cites nothing can be extended but not reworded.
function unreleasedRemovalViolation({ path, before, after }) {
	const kept = new Set(after.split("\n").map((line) => line.trim()));
	const baseBullets = unreleasedBullets(before);
	const baseSet = new Set(baseBullets);
	const candidates = unreleasedBullets(after)
		.filter((line) => !baseSet.has(line))
		.map((line) => ({ line, references: bulletReferences(line) }));
	const removed = baseBullets.filter((line) => {
		if (kept.has(line)) return false;
		const references = bulletReferences(line);
		const stem = line.replace(/[\s.]+$/, "");
		const match = candidates.findIndex(
			(candidate) =>
				candidate.line.startsWith(stem) ||
				(references.size > 0 && [...references].every((reference) => candidate.references.has(reference))),
		);
		if (match === -1) return true;
		candidates.splice(match, 1);
		return false;
	});
	return removed.length > 0
		? `${path}: removes ${removed.length} existing [Unreleased] entr${removed.length === 1 ? "y" : "ies"}, first: ${removed[0]}`
		: undefined;
}

export function checkPrChangelog({
	changedFiles,
	labels,
	trackerPolicy,
	changelogChanges = [],
	trackerRemovals = [],
	fragmentChangelogs = [],
	fragmentViolations = [],
}) {
	const normalizedLabels = (labels ?? []).map((label) => label.trim()).filter(Boolean);
	const hasNoChangelogLabel = normalizedLabels.includes(NO_CHANGELOG_LABEL);
	// A changes/unreleased/<pr>.md block for a package CHANGELOG.md is that package's entry (senpi#3610).
	const changelogFiles = [...changedFiles.filter(isChangelogChange), ...fragmentChangelogs];
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
	const violations = [
		...fragmentViolations,
		...changelogChanges.flatMap(releasedChangelogViolations),
		...trackerRemovals
			.filter(({ removed }) => removed > 0)
			.map(({ path, removed }) => `${path}: removes ${removed} existing line(s); tracker entries may only be added`),
		...changelogChanges.map(unreleasedRemovalViolation).filter(Boolean),
	];
	let pass;
	let reason;
	if (violations.length > 0) {
		pass = false;
		reason = violations.join("; ");
	} else if (audit && uncovered.length > 0) {
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

	return { pass, reason, violations, runtimeFiles, changelogFiles, hasNoChangelogLabel, uncovered };
}

function printUsage() {
	console.log("usage: node scripts/check-pr-changelog.mjs --base <sha> [--labels a,b,c] [--help]");
	console.log("");
	console.log("Checks the PR for a package CHANGELOG.md fragment block (or the 'no-changelog'");
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
	let changelogChanges;
	let trackerRemovals;
	let fragmentChangelogs;
	let fragmentViolations;
	try {
		const facts = collectPrFacts(args.base);
		changedFiles = facts.changedFiles;
		trackerPolicy = facts.trackerPolicy;
		changelogChanges = facts.changelogChanges;
		trackerRemovals = facts.trackerRemovals;
		fragmentChangelogs = facts.fragmentChangelogs;
		fragmentViolations = facts.fragmentViolations;
	} catch (error) {
		console.error(`changelog-gate: ERROR - ${error.message}`);
		return 1;
	}

	const result = checkPrChangelog({
		changedFiles,
		labels: args.labels,
		trackerPolicy,
		changelogChanges,
		trackerRemovals,
		fragmentChangelogs,
		fragmentViolations,
	});
	const verdict = result.pass ? "PASS" : "FAIL";
	console.log(`changelog-gate: ${verdict} - ${result.violations[0] ?? result.reason}`);
	if (!result.pass) {
		for (const violation of result.violations) {
			console.log(`  violation: ${violation}`);
		}
		for (const file of result.runtimeFiles) {
			console.log(`  runtime change: ${file}`);
		}
		for (const path of result.uncovered) {
			console.log(`  missing changes.md coverage: ${path}`);
		}
		console.log(
			"Restore any changed released sections and any removed change-log entries. " +
				"Add your entries to changes/unreleased/<pr>.md (one block per package CHANGELOG.md and changes.md), " +
				`apply the '${NO_CHANGELOG_LABEL}' label if this change is not user-facing, ` +
				"and cover each change in a block for its exact nearest changes.md tracker.",
		);
	}
	return result.pass ? 0 : 1;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	process.exit(main(process.argv.slice(2)));
}
