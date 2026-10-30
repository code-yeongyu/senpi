#!/usr/bin/env node
// Per-PR change fragments (senpi#3610, senpi#3123). A PR never edits an existing changes.md tracker or a
// package CHANGELOG.md [Unreleased] section: it adds ONE file, changes/unreleased/<pr>.md, with one block
// per log it would have edited. Only the release cut compiles the blocks into their logs and deletes
// the fragments before stamping, so two PRs never touch the same file and a pinned release does not
// leave shipped fragment bullets in main's [Unreleased].
//
//   <!-- changes-log: packages/ai/src/api/changes.md -->
//   ## 2026-10-20 - Title (senpi#1234)
//   ### What changed
//   ...
//
//   <!-- changes-log: packages/ai/CHANGELOG.md -->
//   ### Fixed
//   - Bullet ([#1234](https://github.com/code-yeongyu/senpi/pull/1234))

import { CHANGELOGS, DEFAULT_UNRELEASED_SUBSECTIONS } from "./release-changelog.mjs";

export const FRAGMENT_DIR = "changes/unreleased";
export const FRAGMENT_README = `${FRAGMENT_DIR}/README.md`;
const FRAGMENT_NAME = /^changes\/unreleased\/([1-9]\d*)\.md$/;
const TARGET_LINE = /^<!-- changes-log: (\S+) -->$/;
const TRACKER = /(^|\/)changes\.md$/;
const TRACKER_HEADING = /^## (?:\d{4}-\d{2}-\d{2}\b|.*\(\d{4}-\d{2}-\d{2}\)\s*$)/;
const CONFLICT_MARKER = /^(<{7}|\|{7}|={7}|>{7})(\s|$)/;

export const isFragmentPath = (path) => path.startsWith(`${FRAGMENT_DIR}/`);
export const fragmentPr = (path) => {
	const match = FRAGMENT_NAME.exec(path);
	return match === null ? undefined : Number(match[1]);
};
export const fragmentPath = (pr) => `${FRAGMENT_DIR}/${pr}.md`;
export const isChangelogTarget = (path) => CHANGELOGS.includes(path);

const trimBlank = (lines) => {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start].trim() === "") start++;
	while (end > start && lines[end - 1].trim() === "") end--;
	return lines.slice(start, end);
};

/** Groups a changelog block's bullets by `### Section`; returns reasons for anything else. */
export function changelogBullets(body) {
	const sections = new Map();
	const reasons = [];
	let current;
	for (const line of body.split("\n")) {
		if (line.trim() === "") continue;
		if (line.startsWith("### ")) {
			current = line.trim();
			if (!DEFAULT_UNRELEASED_SUBSECTIONS.includes(current)) {
				reasons.push(`\`${current}\` is not one of ${DEFAULT_UNRELEASED_SUBSECTIONS.join(", ")}`);
			}
			continue;
		}
		if (current === undefined) {
			reasons.push("a changelog block starts with `### <Section>`");
			break;
		}
		if (/^\s/.test(line) && (sections.get(current) ?? []).length > 0) {
			sections.get(current).push(line);
			continue;
		}
		if (!/^[-*] /.test(line)) reasons.push(`\`${line.slice(0, 40)}\` is not a bullet`);
		sections.set(current, [...(sections.get(current) ?? []), line]);
	}
	if (reasons.length === 0 && sections.size === 0) reasons.push("a changelog block holds no bullet");
	return { sections, reasons };
}

/** Splits a fragment into blocks; a non-empty `reasons` means it must not be used. */
export function parseFragment(content) {
	const reasons = [];
	const raw = [];
	let current;
	for (const [index, line] of content.replace(/\r\n/g, "\n").split("\n").entries()) {
		const target = TARGET_LINE.exec(line);
		if (target !== null) {
			current = { log: target[1], lines: [] };
			raw.push(current);
		} else if (current !== undefined) {
			current.lines.push(line);
		} else if (line.trim() !== "") {
			reasons.push(`line ${index + 1} sits before the first \`<!-- changes-log: <path> -->\``);
		}
	}
	const blocks = raw.map(({ log, lines }) => ({ log, body: trimBlank(lines).join("\n") }));
	if (blocks.length === 0) reasons.push("holds no `<!-- changes-log: <path> -->` block");
	const seen = new Set();
	for (const { log, body } of blocks) {
		if (seen.has(log)) reasons.push(`\`${log}\` has two blocks; merge them`);
		seen.add(log);
		if (body.split("\n").some((line) => CONFLICT_MARKER.test(line))) {
			reasons.push(`the \`${log}\` block contains merge-conflict markers`);
		}
		if (isChangelogTarget(log)) {
			reasons.push(...changelogBullets(body).reasons.map((reason) => `${log}: ${reason}`));
		} else if (TRACKER.test(log) && !log.startsWith("/") && !log.split("/").includes("..")) {
			if (!TRACKER_HEADING.test(body.split("\n")[0] ?? "")) {
				reasons.push(`the \`${log}\` block starts with a dated \`## \` heading`);
			}
		} else {
			reasons.push(`\`${log}\` is neither a changes.md tracker nor a release CHANGELOG.md`);
		}
	}
	return { blocks, reasons };
}

/** Prepends tracker entries above the first `## ` heading (trackers are newest-first). */
export function insertTrackerEntries(log, entries) {
	const text = entries.join("\n\n");
	const lines = log.split("\n");
	const first = lines.findIndex((line) => line.startsWith("## "));
	if (first < 0) return `${log.replace(/\n*$/, "")}${log.trim() === "" ? "" : "\n\n"}${text}\n`;
	const preamble = lines.slice(0, first).join("\n").replace(/\n*$/, "");
	return `${preamble === "" ? "" : `${preamble}\n\n`}${text}\n\n${lines.slice(first).join("\n")}`;
}

/** Appends bullets at the end of their `### Section` under `## [Unreleased]`, creating it in order. */
export function insertChangelogBullets(log, sections) {
	const lines = log.split("\n");
	const start = lines.findIndex((line) => line.trim() === "## [Unreleased]");
	if (start < 0) throw new Error("no ## [Unreleased] section");
	for (const heading of DEFAULT_UNRELEASED_SUBSECTIONS) {
		const bullets = sections.get(heading);
		if (!bullets) continue;
		let end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
		if (end < 0) end = lines.length;
		let at = lines.findIndex((line, index) => index > start && index < end && line.trim() === heading);
		if (at < 0) {
			const later = DEFAULT_UNRELEASED_SUBSECTIONS.slice(DEFAULT_UNRELEASED_SUBSECTIONS.indexOf(heading) + 1);
			const next = lines.findIndex((line, index) => index > start && index < end && later.includes(line.trim()));
			const insertAt = next < 0 ? end : next;
			lines.splice(insertAt, 0, heading, "", "");
			at = insertAt;
			end += 3;
		}
		let last = at;
		for (let index = at + 1; index < end && !lines[index].startsWith("### "); index++) {
			if (lines[index].trim() !== "") last = index;
		}
		lines.splice(last + 1, 0, ...(last === at ? ["", ...bullets] : bullets));
	}
	return lines.join("\n");
}

/** Plans a compile over `[{ path, content }]`; all-or-nothing on any invalid fragment. */
export function planCompile(fragments, readLog) {
	const reasons = [];
	const byLog = new Map();
	const ordered = fragments
		.map((fragment) => ({ ...fragment, pr: fragmentPr(fragment.path) }))
		.sort((left, right) => (right.pr ?? 0) - (left.pr ?? 0));
	for (const { path, content, pr } of ordered) {
		const { blocks, reasons: invalid } = parseFragment(content);
		if (pr === undefined) invalid.unshift("a fragment is named `<pr-number>.md`");
		if (invalid.length > 0) {
			reasons.push(`${path}: ${invalid.join("; ")}`);
			continue;
		}
		for (const { log, body } of blocks) byLog.set(log, [...(byLog.get(log) ?? []), body]);
	}
	const writes = new Map();
	for (const [log, bodies] of byLog) {
		const current = readLog(log);
		if (current === "") {
			reasons.push(`${log} does not exist; a fragment names a missing log`);
			continue;
		}
		if (!isChangelogTarget(log)) {
			writes.set(log, insertTrackerEntries(current, bodies));
			continue;
		}
		// Oldest PR first inside each section, so a section reads in merge order like hand-written ones.
		const merged = new Map();
		for (const body of [...bodies].reverse()) {
			for (const [heading, bullets] of changelogBullets(body).sections) {
				merged.set(heading, [...(merged.get(heading) ?? []), ...bullets]);
			}
		}
		writes.set(log, insertChangelogBullets(current, merged));
	}
	return { writes, deletes: ordered.map(({ path }) => path), reasons };
}

export const renderFragment = (blocks) =>
	`${blocks.map(({ log, body }) => `<!-- changes-log: ${log} -->\n${body}`).join("\n\n")}\n`;
