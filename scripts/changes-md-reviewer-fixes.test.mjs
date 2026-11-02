#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isProductionPath, isRuntimeSourceChange, parseTrackerEntries } from "./changes-md-policy.mjs";
import { listTrackerFiles, validateGitRevision } from "./changes-md-git.mjs";
import { parseArgs, restrictTrackerEntriesToAddedLines } from "./check-pr-changelog.mjs";

const CANONICAL_SECTIONS = [
	"What changed",
	"Why",
	"Why an extension could not handle it",
	"Expected merge conflict zones",
];

function datedEntry(heading, sections) {
	const body = sections
		.map(
			([title, bullet]) => `### ${title}
- ${bullet}
`,
		)
		.join("\n");
	return `## ${heading}

${body}`;
}

describe("reviewer-cited changes.md policy fixes", () => {
	it("parses date-first headings as coverage entries", () => {
		const content = datedEntry("2026-08-17 — Dual JSONC/JSON settings coverage", [
			["What changed", "`settings-manager.ts`"],
			["Why", "JSONC must load beside JSON."],
			["Why an extension could not handle it", "Settings load before extensions."],
			["Expected merge conflict zones", "settings-manager.ts"],
		]);
		const entries = parseTrackerEntries(content, "packages/coding-agent/src/changes.md");
		assert.equal(entries.length, 1, "date-first ## YYYY-MM-DD headings must produce an entry");
		assert.ok(
			entries[0].covers.includes("packages/coding-agent/src/settings-manager.ts"),
			`date-first entry must resolve covers, got ${JSON.stringify(entries[0].covers)}`,
		);
		assert.deepEqual(new Set(entries[0].sections), new Set(CANONICAL_SECTIONS));
	});

	it("canonicalizes established Why and conflict heading dialects", () => {
		const content = datedEntry("Settings JSONC (2026-08-16)", [
			["What changed and why", "`settings-manager.ts`"],
			["Why", "JSONC must load beside JSON."],
			["Why the extension system could not handle this", "Settings load before extensions."],
			["Expected merge conflict zones on next upstream sync", "settings-manager.ts"],
		]);
		const entries = parseTrackerEntries(content, "packages/coding-agent/src/changes.md");
		assert.equal(entries.length, 1);
		assert.deepEqual(
			new Set(entries[0].sections),
			new Set(CANONICAL_SECTIONS),
			`established dialects must map to canonical sections, got ${JSON.stringify(entries[0].sections)}`,
		);
	});

	it("excludes generated catalog-style source from production and changelog runtime", () => {
		const generated = "packages/ai/src/providers/data/catalog.generated.ts";
		assert.equal(isProductionPath(generated), false, "*.generated.ts must not be an audited production path");
		assert.equal(isRuntimeSourceChange(generated), false, "*.generated.ts must not require CHANGELOG.md");
	});

	it("skips symlink tracker files when listing the working tree", () => {
		const root = mkdtempSync(join(tmpdir(), "changes-md-symlink-"));
		mkdirSync(join(root, "real"));
		mkdirSync(join(root, "link"));
		writeFileSync(join(root, "real", "changes.md"), "## Real (2026-08-17)\n\n### Why\n- real\n");
		symlinkSync(join(root, "real", "changes.md"), join(root, "link", "changes.md"));
		const found = listTrackerFiles(root);
		assert.deepEqual(
			found.filter((path) => path.endsWith("link/changes.md")),
			[],
			"symlink changes.md files must not be treated as trackers",
		);
		assert.ok(
			found.some((path) => path.endsWith("real/changes.md")),
			"regular tracker files must still be listed",
		);
	});

	it("credits only added tracker lines, not stale full-file entries", () => {
		const tracker = "packages/ai/src/changes.md";
		const content = `## Stale (2026-08-01)

### What changed
- \`legacy.ts\`

### Why
- old

### Why an extension could not handle it
- old

### Expected merge conflict zones
- old

## Fresh (2026-08-17)

### What changed
- \`index.ts\`

### Why
- new

### Why an extension could not handle it
- new

### Expected merge conflict zones
- new
`;
		const entries = parseTrackerEntries(content, tracker);
		const added = new Set(["- `index.ts`", "- new"]);
		const touched = restrictTrackerEntriesToAddedLines(entries, added, tracker);
		assert.deepEqual(
			touched.flatMap((entry) => entry.covers),
			["packages/ai/src/index.ts"],
			"stale entries that already name a path must not be credited unless their lines were added",
		);
	});

	it("rejects option-like --base values before they reach git", () => {
		assert.throws(() => validateGitRevision("--output=/tmp/pwned"), /invalid git revision/);
		assert.throws(() => validateGitRevision("-C"), /invalid git revision/);
		assert.throws(() => validateGitRevision("HEAD; rm -rf /"), /invalid git revision/);
		assert.equal(validateGitRevision("d641e7e4d21e15632135db1381a8e8fdce59a3a4"), "d641e7e4d21e15632135db1381a8e8fdce59a3a4");
	});

	it("reads changelog-gate labels from the environment instead of the argv string", () => {
		const args = parseArgs([], {
			CHANGELOG_GATE_BASE: "d641e7e4d21e15632135db1381a8e8fdce59a3a4",
			CHANGELOG_GATE_LABELS: "bug,no-changelog",
		});
		assert.equal(args.base, "d641e7e4d21e15632135db1381a8e8fdce59a3a4");
		assert.deepEqual(args.labels, ["bug", "no-changelog"]);
	});
});
