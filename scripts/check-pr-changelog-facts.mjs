#!/usr/bin/env node
// PR fact collection for the changelog gate (moved from check-pr-changelog.mjs; the gate keeps the verdict).
import { readFileSync } from "node:fs";
import { FRAGMENT_README } from "./changes-fragments.mjs";
import { collectFragmentFacts } from "./changes-fragments-gate.mjs";
import {
	isProductionPath,
	parseTrackerEntries,
	restrictTrackerEntriesToAddedLines,
	UPSTREAM_PIN_PATH,
} from "./changes-md-policy.mjs";
import {
	ensureCommitExists,
	filesInCommit,
	listTrackerFiles,
	readUpstreamPin,
	resolvePrNameStatus,
	runGit,
} from "./changes-md-git.mjs";


export const CHANGELOG_PATTERN = /(^|\/)CHANGELOG\.md$/i;
const TRACKER_PATTERN = /(^|\/)changes\.md$/;

export function isChangelogChange(path) {
	return CHANGELOG_PATTERN.test(path);
}

export function changelogSections(text) {
	const headings = [...text.matchAll(/^## \[([^\]]+)\].*$/gm)];
	return headings.map((heading, index) => ({
		name: heading[1],
		line: text.slice(0, heading.index).split("\n").length,
		text: text.slice(heading.index, headings[index + 1]?.index ?? text.length),
		body: text.slice(heading.index + heading[0].length, headings[index + 1]?.index ?? text.length),
	}));
}

function diffPathsBetween(from, to) {
	const what = `git diff --name-only ${from} ${to}`;
	return runGit(["diff", "--name-only", from, to], what)
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

// Counts base lines missing from the head by content (blank lines ignored), so diff alignment around a prepend never reads as a removal.
function removedLineCount(before, after) {
	const remaining = new Map();
	for (const line of after.split("\n")) {
		const key = line.trim();
		if (key) remaining.set(key, (remaining.get(key) ?? 0) + 1);
	}
	let removed = 0;
	for (const line of before.split("\n")) {
		const key = line.trim();
		if (!key) continue;
		const count = remaining.get(key) ?? 0;
		if (count > 0) remaining.set(key, count - 1);
		else removed += 1;
	}
	return removed;
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
export function collectPrFacts(base) {
	const pin = readUpstreamPin(UPSTREAM_PIN_PATH);
	ensureCommitExists(pin.sha);
	const { changedFiles, renames } = resolvePrNameStatus(base);
	const mergeBase = runGit(["merge-base", base, "HEAD"], "resolving PR merge base").trim();
	const baseFiles = filesInCommit(mergeBase);
	const headFiles = filesInCommit("HEAD");
	const changelogChanges = changedFiles.filter(isChangelogChange)
		.filter((path) => !renames.some((rename) => rename.from === path && isChangelogChange(rename.to)))
		.map((path) => {
			const oldPath = renames.find((rename) => rename.to === path)?.from ?? path;
			const before = baseFiles.has(oldPath) ? runGit(["show", `${mergeBase}:${oldPath}`], `reading base ${oldPath}`) : "";
			const after = headFiles.has(path) ? runGit(["show", `HEAD:${path}`], `reading HEAD ${path}`) : "";
			const previous = changelogSections(before);
			const taggedSections = Object.create(null);
			for (const section of changelogSections(after)) {
				if (section.name === "Unreleased" || previous.find((old) => old.name === section.name)?.text === section.text) continue;
				// Release names are plain CalVer; anything else (revision syntax such as `~1`) gets no exemption.
				if (!/^[0-9][0-9A-Za-z.-]*$/.test(section.name)) continue;
				const tag = `refs/tags/v${section.name}`;
				let tagged;
				try {
					runGit(["show-ref", "--verify", "--quiet", tag], `verifying ${tag}`);
					tagged = runGit(["show", `${tag}:${path}`], `reading tagged ${path}`);
				} catch {
					continue;
				}
				const taggedSection = changelogSections(tagged).find((candidate) => candidate.name === section.name);
				if (taggedSection) taggedSections[section.name] = taggedSection.text;
			}
			return { path, before, after, taggedSections };
		});
	const trackerRemovals = changedFiles
		.filter((path) => TRACKER_PATTERN.test(path) && baseFiles.has(path))
		.map((path) => {
			const after = headFiles.has(path) ? runGit(["show", `HEAD:${path}`], `reading HEAD ${path}`) : "";
			return { path, removed: removedLineCount(runGit(["show", `${mergeBase}:${path}`], `reading base ${path}`), after) };
		});
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
	const readAt = (rev, files) => (path) => (files.has(path) ? runGit(["show", `${rev}:${path}`], `reading ${rev} ${path}`) : "");
	const records = runGit(["diff", "--name-status", "--no-renames", mergeBase, "HEAD"], "listing PR file statuses")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [status, path] = line.split("\t");
			return { status: status[0], path };
		});
	const fragments = collectFragmentFacts({
		records,
		readHead: readAt("HEAD", headFiles),
		readBase: readAt(mergeBase, baseFiles),
		headFiles,
		adopted: baseFiles.has(FRAGMENT_README),
	});
	for (const [tracker, entries] of Object.entries(fragments.trackerEntries)) {
		trackerDiffs[tracker] = [...(trackerDiffs[tracker] ?? []), ...entries];
	}
	return {
		changedFiles,
		fragmentChangelogs: fragments.changelogs,
		fragmentViolations: fragments.violations,
		changelogChanges,
		trackerRemovals,
		trackerPolicy: {
			forkOnly,
			trackerDiffs,
			existingTrackers,
			renames: upstreamRenames,
			upstreamSync: pinChanged ? { pinChanged: true, divergentFiles } : undefined,
		},
	};
}
