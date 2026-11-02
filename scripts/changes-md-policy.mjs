#!/usr/bin/env node
// Shared changes.md policy: pure classification and coverage rules for the
// checkPrChangelog seam, plus the collectors both CLIs need. Local git and
// filesystem only; collectors throw so callers fail closed.

import { basename, dirname, join } from "node:path";

export const CANONICAL_SECTIONS = [
	"What changed",
	"Why",
	"Why an extension could not handle it",
	"Expected merge conflict zones",
];
export const UPSTREAM_PIN_PATH = ".github/upstream.json";

const RELEASE_MANAGED_PACKAGES = ["ai", "agent", "coding-agent", "tui", "pty", "senpi-codemode"];
const RUNTIME_SOURCE_PATTERN = new RegExp(`^packages/(?:${RELEASE_MANAGED_PACKAGES.join("|")})/src/`);
const CRATES_SOURCE_PATTERN = /^crates\/senpi-pty\//;
const GENERATED_FILE_PATTERN = /\.generated\.[cm]?[jt]sx?$/;
const TRACKER_PATTERN = /(^|\/)changes\.md$/i;
const TEST_TREE_PATTERN = /(^|\/)(__tests__|tests?|fixtures?|examples|docs?)\//;
const TEST_FILE_PATTERN = /\.(test|spec)(-d)?\.[cm]?[jt]sx?$/;
const DOCS_PATTERN = /\.(md|mdx)$/i;
const LOCKFILE_PATTERN =
	/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock|Cargo\.lock)$/;
const NON_PRODUCTION_METADATA_PATTERN = /(^|\/)(\.gitignore|LICENSE)$/;

export const isTrackerPath = (path) => TRACKER_PATTERN.test(path);
export const isTestFile = (path) => TEST_TREE_PATTERN.test(path) || TEST_FILE_PATTERN.test(path);
export const isDocsFile = (path) => DOCS_PATTERN.test(path);

/** Release-gate classifier: runtime source that historically required CHANGELOG.md. */
export function isRuntimeSourceChange(path) {
	if (GENERATED_FILE_PATTERN.test(path)) return false;
	if (isTestFile(path) || isDocsFile(path)) return false;
	return RUNTIME_SOURCE_PATTERN.test(path) || CRATES_SOURCE_PATTERN.test(path);
}

/** Audit classifier: upstream-owned production trees minus non-production surfaces. */
export function isProductionPath(path) {
	if (isTrackerPath(path) || path === UPSTREAM_PIN_PATH) return false;
	if (LOCKFILE_PATTERN.test(path) || path.endsWith(".lock") || path.endsWith(".lock.json")) return false;
	if (NON_PRODUCTION_METADATA_PATTERN.test(path) || /(^|\/)test\.sh$/.test(path)) return false;
	if (isTestFile(path) || isDocsFile(path)) return false;
	if (GENERATED_FILE_PATTERN.test(path)) return false;
	return true;
}

/** Exact nearest ancestor changes.md for a path among the known trackers. */
export function nearestTrackerFor(path, knownTrackers) {
	const known = new Map([...knownTrackers].map((tracker) => [tracker.toLowerCase(), tracker]));
	const parts = path.split("/");
	const candidates = ["changes.md"];
	for (let depth = 1; depth < parts.length; depth += 1) {
		candidates.push([...parts.slice(0, depth), "changes.md"].join("/"));
	}
	for (const candidate of candidates.reverse()) {
		const match = known.get(candidate.toLowerCase());
		if (match) return match;
	}
	return null;
}

/** Coverage requires the exact audited path plus every canonical section. */
export function entryCovers(entry, path) {
	return (entry?.covers ?? []).includes(path) && CANONICAL_SECTIONS.every((s) => (entry?.sections ?? []).includes(s));
}

function normalizeTrackerPolicy(raw) {
	const sync = raw?.upstreamSync;
	return {
		forkOnly: new Set(raw?.forkOnly ?? []),
		trackerDiffs: new Map(Object.entries(raw?.trackerDiffs ?? {})),
		existingTrackers: new Set(raw?.existingTrackers ?? Object.keys(raw?.trackerDiffs ?? {})),
		renameSources: new Set((raw?.renames ?? []).map((rename) => rename.from)),
		renameDestinations: new Set((raw?.renames ?? []).map((rename) => rename.to)),
		sync: sync?.pinChanged ? { divergentFiles: sync.divergentFiles ?? [] } : null,
	};
}

/**
 * Classifies every changed path against the tracker policy and returns, in
 * changed-file order, covered and uncovered production paths with the exact
 * nearest tracker and a reason per uncovered path.
 */
export function auditChangesMdCoverage({ changedFiles, trackerPolicy }) {
	const policy = normalizeTrackerPolicy(trackerPolicy);
	const knownTrackers = new Set([
		...policy.existingTrackers,
		...policy.trackerDiffs.keys(),
		...changedFiles.filter(isTrackerPath),
	]);
	const covered = [];
	const uncovered = [];
	for (const file of changedFiles) {
		if (policy.renameSources.has(file)) continue;
		if (!isProductionPath(file)) continue;
		if (policy.forkOnly.has(file) && !policy.renameDestinations.has(file)) continue;
		if (policy.sync && !policy.sync.divergentFiles.includes(file)) continue;
		const nearest = nearestTrackerFor(file, knownTrackers);
		const entries = nearest ? (policy.trackerDiffs.get(nearest) ?? []) : [];
		if (entries.some((entry) => entryCovers(entry, file))) {
			covered.push({ path: file, tracker: nearest });
			continue;
		}
		const reason = !nearest
			? "no nearest changes.md tracker found"
			: entries.some((entry) => (entry?.covers ?? []).includes(file))
				? "nearest changes.md entry missing canonical sections"
				: "nearest changes.md entry does not cover path";
		uncovered.push({ path: file, nearestTracker: nearest, reason });
	}
	return { covered, uncovered };
}

/** Gate reason for an uncovered set; always names changes.md. */
export function summarizeUncovered(uncovered) {
	const byReason = new Map();
	for (const item of uncovered) {
		byReason.set(item.reason, [...(byReason.get(item.reason) ?? []), item.path]);
	}
	const detail = [...byReason.entries()].map(([reason, paths]) => `${reason}: ${paths.join(", ")}`);
	return `changes.md coverage missing for ${uncovered.length} production path(s) - ${detail.join("; ")}`;
}

const SECTION_ALIASES = [
	[/^what changed(?: and why)?$/i, "What changed"],
	[/^files modified$/i, "What changed"],
	[/^modified upstream files$/i, "What changed"],
	[/^why$/i, "Why"],
	[/^why (?:an |the |the higher-level )?(?:extension|extensions)\b.*$/i, "Why an extension could not handle it"],
	[/^why not (?:an )?extension\b.*$/i, "Why an extension could not handle it"],
	[/^why this cannot be expressed (?:externally|as an extension)$/i, "Why an extension could not handle it"],
	[/^why this is not extension-only$/i, "Why an extension could not handle it"],
	[/^why this lives in the fork$/i, "Why an extension could not handle it"],
	[/^why this belongs in core$/i, "Why an extension could not handle it"],
	[/^why not core$/i, "Why an extension could not handle it"],
	[/^why extension hooks alone could not handle this$/i, "Why an extension could not handle it"],
	[/^why an extension-local change is required$/i, "Why an extension could not handle it"],
	[/^(?:expected )?(?:upstream )?(?:merge[ -]?)?conflict zones?(?:$|\b.*)/i, "Expected merge conflict zones"],
	[/^coverage and expected conflict zones$/i, "Expected merge conflict zones"],
];
function canonicalSection(heading) {
	const match = SECTION_ALIASES.find(([pattern]) => pattern.test(heading.trim()));
	return match ? match[1] : null;
}

const PATH_TOKEN =
	/(?:packages|crates|scripts|\.github|docs|test)\/[A-Za-z0-9._/-]+|\b[A-Za-z0-9._-]+\.[cm]?[jt]sx?\b|\b[A-Za-z0-9._-]+\.(?:rs|json|toml|ya?ml|sh|md)\b/g;
const INLINE_CODE_TOKEN = /`([^`]+)`/g;
const FILE_NAME_TOKEN =
	/^[A-Za-z0-9._-]+\.(?:[cm]?[jt]sx?|d\.ts|rs|json|jsonc|toml|ya?ml|sh|ps1|md|mdx|css)$/;

function resolveToken(base, token) {
	if (/^[a-z]+:\/\//i.test(token) || token.startsWith("@")) return null;
	if (/^(packages|crates|scripts|\.github|docs|test)\//.test(token)) return token;
	if (token.startsWith(".")) return token.replace(/^\.\//, "");
	if (token.includes("/")) return join(base, token).replace(/\\/g, "/");
	if (!FILE_NAME_TOKEN.test(basename(token))) return null;
	return join(base, token).replace(/\\/g, "/");
}
/**
 * Parses full tracker contents into coverage entries. An entry spans one
 * `## <title> (<date>)` block; sections are its canonicalized `###` headings,
 * covers are repo-relative path tokens resolved from the tracker folder, and
 * markers keeps raw bullet lines for PR-diff touch detection.
 */
export function parseTrackerEntries(content, trackerPath) {
	const base = dirname(trackerPath);
	const entries = [];
	for (const block of content.split(/^## (?=(?:\d{4}-\d{2}-\d{2}\b)|(?:.*\(\d{4}-\d{2}-\d{2}\)\s*$))/m).slice(1)) {
		const sections = new Set();
		const covers = new Set();
		const markers = new Set();
		for (const line of block.split("\n")) {
			const heading = line.match(/^###\s+(.+?)\s*$/);
			if (heading) {
				const canonical = canonicalSection(heading[1]);
				if (canonical) sections.add(canonical);
				continue;
			}
			const bullet = line.trim();
			if (bullet.startsWith("-")) markers.add(bullet);
			for (const match of bullet.matchAll(INLINE_CODE_TOKEN)) {
				const resolved = resolveToken(base, match[1]);
				if (resolved) covers.add(resolved);
			}
			const prose = bullet.replace(INLINE_CODE_TOKEN, "");
			for (const match of prose.matchAll(PATH_TOKEN)) {
				const resolved = resolveToken(base, match[0]);
				if (resolved) covers.add(resolved);
			}
		}
		entries.push({ covers: [...covers], sections: [...sections], markers: [...markers] });
	}
	return entries;
}

/** Keep only entries whose added bullet lines mention a path; sections stay. */
export function restrictTrackerEntriesToAddedLines(entries, addedLines, trackerPath) {
	const added = addedLines instanceof Set ? addedLines : new Set(addedLines);
	const touched = [];
	for (const entry of entries) {
		const addedMarkers = (entry?.markers ?? []).filter((marker) => added.has(marker));
		if (addedMarkers.length === 0) continue;
		const parsed = parseTrackerEntries(`## Added (1970-01-01)\n${addedMarkers.join("\n")}\n`, trackerPath);
		touched.push({
			covers: parsed[0]?.covers ?? [],
			sections: entry.sections ?? [],
			markers: addedMarkers,
		});
	}
	return touched;
}
