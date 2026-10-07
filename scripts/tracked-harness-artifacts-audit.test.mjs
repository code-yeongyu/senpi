#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Harness state (.omo/, local-ignore/, hand-typed QA capture roots) is per-session and stays local;
// the PR body carries the QA summary (senpi#2029). This audit reads the index directly rather than
// .gitignore, so a `git add -f` or a later negation cannot re-track it without turning CI red.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PREVIEW_LIMIT = 25;

export const TRACKED_HARNESS_ALLOWLIST = new Set([".omo/init-deep.json"]);

export const HARNESS_ROOT_PATTERNS = [
	{ label: ".omo/ (except the init-deep snapshot)", pattern: /^\.omo\// },
	{ label: "packages/*/.omo/", pattern: /^packages\/[^/]+\/\.omo\// },
	{ label: "local-ignore/", pattern: /^local-ignore\// },
	{ label: ".qa-evidence/ (any depth)", pattern: /(^|\/)\.qa-evidence\// },
	{ label: "qa-evidence/ (any depth)", pattern: /(^|\/)qa-evidence\// },
];

export function findTrackedHarnessPaths(paths) {
	return paths
		.filter((path) => !TRACKED_HARNESS_ALLOWLIST.has(path))
		.filter((path) => HARNESS_ROOT_PATTERNS.some((root) => root.pattern.test(path)))
		.sort();
}

function listTrackedPaths() {
	const output = execFileSync("git", ["ls-files", "--cached", "-z"], { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	return output.split("\0").filter(Boolean);
}

function describeViolations(paths) {
	if (paths.length === 0) return "";
	const preview = paths.slice(0, PREVIEW_LIMIT).map((path) => `  ${path}`);
	const remainder = paths.length > PREVIEW_LIMIT ? [`  ... and ${paths.length - PREVIEW_LIMIT} more`] : [];
	const roots = HARNESS_ROOT_PATTERNS.map((root) => root.label).join(", ");
	return [
		`${paths.length} tracked file(s) live under a harness-state root (${roots}).`,
		"These stay local; summarize QA in the PR body and remove them from the index with `git rm -r --cached <path>`:",
		...preview,
		...remainder,
	].join("\n");
}

describe("tracked harness artifacts audit", () => {
	it("given the committed tree, when scanned for harness-state roots, then no tracked file lives under one", () => {
		const violations = describeViolations(findTrackedHarnessPaths(listTrackedPaths()));
		assert.equal(violations, "");
	});

	it("given paths inside and outside the roots, when filtered, then only harness paths minus the allowlist are reported", () => {
		const reported = findTrackedHarnessPaths([
			".omo/evidence/20260706-b1-w0-audit-fix/summary.md",
			".omo/plans/loop-guard-escalation.md",
			".omo/init-deep.json",
			"packages/coding-agent/.omo/evidence/x.txt",
			"local-ignore/qa-evidence/20260708-mcp-w3-todo28/INDEX.md",
			".qa-evidence/senpi-RED.txt",
			"packages/ai/.qa-evidence/GREEN.txt",
			"packages/coding-agent/test/qa/app-server/task20-doc-example-check.ts",
			"scripts/qa/eval-multi-job.ts",
		]);
		assert.deepEqual(reported, [
			".omo/evidence/20260706-b1-w0-audit-fix/summary.md",
			".omo/plans/loop-guard-escalation.md",
			".qa-evidence/senpi-RED.txt",
			"local-ignore/qa-evidence/20260708-mcp-w3-todo28/INDEX.md",
			"packages/ai/.qa-evidence/GREEN.txt",
			"packages/coding-agent/.omo/evidence/x.txt",
		]);
	});
});
