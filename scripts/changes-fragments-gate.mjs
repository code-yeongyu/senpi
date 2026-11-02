#!/usr/bin/env node
// The fragment half of the changelog gate (senpi#3610): what a PR's changes/unreleased/<pr>.md covers,
// and why a fragment or a direct log edit is refused. Pure over the git reads it is handed.

import { FRAGMENT_README, fragmentPr, isChangelogTarget, isFragmentPath, parseFragment } from "./changes-fragments.mjs";
import { parseTrackerEntries } from "./changes-md-policy.mjs";

const UNRELEASED_SECTION = /^## \[Unreleased\][^\n]*\n([\s\S]*?)(?=^## \[|(?![\s\S]))/m;
const bulletCount = (text) =>
	(UNRELEASED_SECTION.exec(text)?.[1] ?? "").split("\n").filter((line) => /^\s*[-*] /.test(line)).length;

/**
 * `records` are `{ status, path }` from `git diff --name-status --no-renames <mergeBase> HEAD`; `readHead`
 * and `readBase` return a file's text ("" when absent); `headFiles` is the head's path set; `adopted` is true
 * once the merge base carries changes/unreleased/README.md.
 * Returns `{ changelogs, trackerEntries, violations }`: CHANGELOG.md paths a fragment covers, tracker
 * entries keyed by tracker (all added by this PR), and refusal reasons.
 */
export function collectFragmentFacts({ records, readHead, readBase, headFiles, adopted }) {
	const changelogs = new Set();
	const trackerEntries = {};
	const violations = [];
	for (const { status, path } of records) {
		if (isFragmentPath(path)) {
			if (path === FRAGMENT_README) continue;
			if (status !== "A") {
				violations.push(`${path}: fragments are immutable once merged; add your own instead`);
				continue;
			}
			const reasons = fragmentPr(path) === undefined ? ["a fragment is named `<pr-number>.md`"] : [];
			const { blocks, reasons: invalid } = parseFragment(readHead(path));
			reasons.push(...invalid);
			for (const { log } of blocks) if (!headFiles.has(log)) reasons.push(`\`${log}\` does not exist at head`);
			if (reasons.length > 0) {
				violations.push(`${path}: ${reasons.join("; ")}`);
				continue;
			}
			for (const { log, body } of blocks) {
				if (isChangelogTarget(log)) changelogs.add(log);
				else trackerEntries[log] = [...(trackerEntries[log] ?? []), ...parseTrackerEntries(body, log)];
			}
			continue;
		}
		// Once fragments are adopted, only the release cut adds to existing logs.
		if (!adopted || status === "A" || status === "D") continue;
		if (/(^|\/)changes\.md$/.test(path)) {
			const before = new Set(
				readBase(path)
					.split("\n")
					.map((line) => line.trim()),
			);
			if (
				readHead(path)
					.split("\n")
					.some((line) => line.trim() !== "" && !before.has(line.trim()))
			) {
				violations.push(
					`${path}: adds to an existing changes.md; put the entry in your changes/unreleased/<pr>.md`,
				);
			}
		} else if (isChangelogTarget(path) && bulletCount(readHead(path)) > bulletCount(readBase(path))) {
			violations.push(`${path}: adds an [Unreleased] bullet; put it in your changes/unreleased/<pr>.md`);
		}
	}
	return { changelogs: [...changelogs].sort(), trackerEntries, violations };
}
