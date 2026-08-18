#!/usr/bin/env node
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkPrChangelog } from "./check-pr-changelog.mjs";
import { parseTrackerEntries } from "./changes-md-policy.mjs";

// Failing-first spec for the repository-wide changes.md audit policy. The
// per-PR gate spec lives in check-pr-changes-md.test.mjs; this file audits the
// whole repository at once. AGENTS.md requires every upstream-owned production
// path to be covered by an entry carrying all four canonical sections in its
// exact nearest changes.md tracker. The same checkPrChangelog seam is
// exercised with a repository-shaped input:
//   - changedFiles carries the repository's production divergence inventory
//     (every path under audit, not a single PR diff)
//   - trackerDiffs carries the parsed state of every changes.md tracker, not
//     only trackers touched by a diff; values are arrays of entries
//   - forkOnly / renames / deletions / upstreamSync keep the fixture shape
//     established in check-pr-changes-md.test.mjs
// The audit reports `uncovered`: the upstream-owned production paths lacking
// exact canonical coverage in their exact nearest tracker, in inventory order.
// `pass` must be false whenever `uncovered` is non-empty. Production files not
// listed in forkOnly are upstream-owned by default. Renamed paths are audited
// at their new path; deleted paths at their recorded path. Pure in-memory
// fixtures keep the audit deterministic (no git, fs, or network access).

const CANONICAL_SECTIONS = [
	"What changed",
	"Why",
	"Why an extension could not handle it",
	"Expected merge conflict zones",
];

const AI_INDEX = "packages/ai/src/index.ts";
const AGENT_LOOP = "packages/agent/src/agent-loop.ts";
const TUI_MAIN = "packages/tui/src/tui.ts";
const CRATES_LIB = "crates/senpi-pty/src/lib.rs";
const FORK_BRANDING = "packages/coding-agent/src/core/fork/senpi-branding.ts";

function trackerEntry(covers, sections = CANONICAL_SECTIONS) {
	return { covers, sections: [...sections] };
}

function trackerPolicy(overrides = {}) {
	return {
		forkOnly: [],
		trackerDiffs: {},
		renames: [],
		deletions: [],
		upstreamSync: undefined,
		...overrides,
	};
}

function auditRepository(inventory, policyOverrides = {}) {
	return checkPrChangelog({
		changedFiles: [...inventory],
		labels: ["no-changelog"],
		trackerPolicy: trackerPolicy(policyOverrides),
	});
}

describe("repository-wide changes.md audit", () => {
	it("parses root dotfiles and hidden-directory paths from canonical tracker entries", () => {
		const entries = parseTrackerEntries(
			`## Root audit (2026-08-17)

### What changed
- \`.husky/pre-commit\`
- \`.npmrc\`
- \`.pi/extensions/tps.ts\`
- \`package.json\`

### Why
- The root policy surfaces diverge from upstream.

### Why an extension could not handle it
- Repository hooks and configuration run outside extension loading.

### Expected merge conflict zones
- Root policy and hidden tool directories.
`,
			"changes.md",
		);
		assert.deepEqual(entries[0]?.covers, [
			".husky/pre-commit",
			".npmrc",
			".pi/extensions/tps.ts",
			"package.json",
		]);
	});

	it("reports an uncovered production path when its nearest tracker has no covering entry", () => {
		const result = auditRepository([AI_INDEX, AGENT_LOOP], {
			trackerDiffs: { "packages/agent/src/changes.md": [trackerEntry([AGENT_LOOP])] },
		});
		assert.deepEqual(
			result.uncovered,
			[AI_INDEX],
			"a production path without a covering entry in its nearest changes.md must be reported uncovered",
		);
		assert.equal(result.pass, false, "a non-empty uncovered set must fail the audit");
	});

	it("removes a production path covered exactly by its nearest tracker with all canonical sections", () => {
		const result = auditRepository([AI_INDEX], {
			trackerDiffs: { "packages/ai/src/changes.md": [trackerEntry([AI_INDEX])] },
		});
		assert.deepEqual(
			result.uncovered,
			[],
			"exact canonical coverage in the nearest tracker must clear the production path",
		);
		assert.equal(result.pass, true, "an empty uncovered set must pass the audit");
	});

	it("keeps docs, tests, generated catalogs, and fork-only paths outside the audit", () => {
		const result = auditRepository(
			[
				AI_INDEX,
				"packages/ai/README.md",
				"packages/ai/src/models.generated.ts",
				"packages/ai/src/api/__tests__/openai.test.ts",
				FORK_BRANDING,
			],
			{ forkOnly: [FORK_BRANDING] },
		);
		assert.deepEqual(
			result.uncovered,
			[AI_INDEX],
			"docs, tests, generated catalogs, and fork-only files are never audited production paths",
		);
	});

	it("maps multiple production paths to their exact nearest trackers only", () => {
		const result = auditRepository([AI_INDEX, TUI_MAIN, CRATES_LIB], {
			trackerDiffs: {
				"packages/ai/src/changes.md": [trackerEntry([AI_INDEX])],
				"packages/tui/src/changes.md": [trackerEntry([TUI_MAIN])],
				"packages/coding-agent/changes.md": [trackerEntry([CRATES_LIB])],
			},
		});
		assert.deepEqual(
			result.uncovered,
			[CRATES_LIB],
			"coverage recorded in a non-nearest changes.md must not clear a production path",
		);
	});

	it("keeps malformed coverage that misses a canonical section in uncovered", () => {
		const result = auditRepository([AI_INDEX], {
			trackerDiffs: {
				"packages/ai/src/changes.md": [trackerEntry([AI_INDEX], CANONICAL_SECTIONS.slice(0, 3))],
			},
		});
		assert.deepEqual(
			result.uncovered,
			[AI_INDEX],
			"an entry missing a canonical section is malformed coverage and stays uncovered",
		);
	});

	it("represents renamed and deleted upstream production paths in uncovered", () => {
		const renamedTo = "packages/tui/src/panels/panel.ts";
		const deletedForkFile = "packages/coding-agent/src/fork/experiment.ts";
		const result = auditRepository([renamedTo, AGENT_LOOP, deletedForkFile], {
			renames: [{ from: "packages/tui/src/panel.ts", to: renamedTo }],
			deletions: [AGENT_LOOP, deletedForkFile],
			forkOnly: [deletedForkFile],
		});
		assert.deepEqual(
			result.uncovered,
			[renamedTo, AGENT_LOOP],
			"renamed upstream paths are audited at their new path, deleted upstream paths at their recorded path, and fork-only deletions never",
		);
	});

	it("removes renamed and deleted upstream paths once their nearest tracker covers them", () => {
		const renamedTo = "packages/tui/src/panels/panel.ts";
		const result = auditRepository([renamedTo, AGENT_LOOP], {
			renames: [{ from: "packages/tui/src/panel.ts", to: renamedTo }],
			deletions: [AGENT_LOOP],
			trackerDiffs: {
				"packages/tui/src/changes.md": [trackerEntry([renamedTo])],
				"packages/agent/src/changes.md": [trackerEntry([AGENT_LOOP])],
			},
		});
		assert.deepEqual(
			result.uncovered,
			[],
			"nearest-tracker coverage must clear renamed and deleted upstream production paths",
		);
	});

	it("reports only integration repairs for a pin-changing upstream sync", () => {
		const result = auditRepository([".github/upstream.json", AGENT_LOOP, TUI_MAIN], {
			upstreamSync: { pinChanged: true, divergentFiles: [AGENT_LOOP] },
		});
		assert.deepEqual(
			result.uncovered,
			[AGENT_LOOP],
			"a pin-changing sync audits only production files that diverge from the new pin",
		);
	});

	it("reports nothing for a clean pin-changing upstream sync", () => {
		const result = auditRepository([".github/upstream.json", AGENT_LOOP, TUI_MAIN], {
			upstreamSync: { pinChanged: true, divergentFiles: [] },
		});
		assert.deepEqual(
			result.uncovered,
			[],
			"a clean sync carries upstream's own edits and needs no changes.md entries",
		);
	});
});
