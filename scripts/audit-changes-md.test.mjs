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
//   - forkOnly / renames / upstreamSync keep the fixture shape
//     established in check-pr-changes-md.test.mjs
// The audit reports `uncovered`: the upstream-owned production paths lacking
// exact canonical coverage in their exact nearest tracker, in inventory order.
// `pass` must be false whenever `uncovered` is non-empty. Production files not
// listed in forkOnly are upstream-owned by default. Renamed paths are audited
// at their new path; a deleted path is an ordinary changed path. Pure in-memory
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

// The per-path policy rows (uncovered, nearest tracker, malformed entries, fork-only, upstream sync)
// live in check-pr-changes-md.test.mjs, which runs the same checkPrChangelog seam.
describe("changes.md tracker parsing and rename coverage", () => {
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

	it("audits a renamed upstream path at its new destination and never a fork-only path", () => {
		const renamedTo = "packages/tui/src/panels/panel.ts";
		const deletedForkFile = "packages/coding-agent/src/fork/experiment.ts";
		const result = auditRepository([renamedTo, AGENT_LOOP, deletedForkFile], {
			renames: [{ from: "packages/tui/src/panel.ts", to: renamedTo }],
			forkOnly: [deletedForkFile],
		});
		assert.deepEqual(
			result.uncovered,
			[renamedTo, AGENT_LOOP],
			"renamed upstream paths are audited at their new path, other upstream paths at their own path, and fork-only paths never",
		);
	});

	it("clears a renamed upstream path once its nearest tracker covers the new destination", () => {
		const renamedTo = "packages/tui/src/panels/panel.ts";
		const result = auditRepository([renamedTo, AGENT_LOOP], {
			renames: [{ from: "packages/tui/src/panel.ts", to: renamedTo }],
			trackerDiffs: {
				"packages/tui/src/changes.md": [trackerEntry([renamedTo])],
				"packages/agent/src/changes.md": [trackerEntry([AGENT_LOOP])],
			},
		});
		assert.deepEqual(
			result.uncovered,
			[],
			"nearest-tracker coverage must clear renamed and ordinary upstream production paths",
		);
	});


});

// senpi#3006: senpi#2895 added five nearer changes.md trackers under
// packages/ai/src/{api,auth,auth/oauth,providers,utils}/ that named only the files
// that PR touched. Coverage is resolved against the exact nearest tracker, so the
// upstream-modified files beneath them - covered by packages/ai/src/changes.md until
// then - turned uncovered overnight (43 of 487). This is a characterization pin of
// the #2895 fixture shape (a nearest tracker listing only some of the files beneath
// it, so the rest go uncovered); the same nearest-tracker shadowing rule is already
// pinned generically in check-pr-changes-md.test.mjs ("fails when only a non-nearest
// changes.md is touched", "does not fall through an existing empty nearest tracker
// to a parent"). The durable recurrence guard is the repository-wide audit now run
// in the changelog-gate CI job (.github/workflows/changelog-gate.yml).
describe("changes.md audit: the senpi#2895 fixture shape (senpi#3006)", () => {
	const AI_SRC_TRACKER = "packages/ai/src/changes.md";
	const API_TRACKER = "packages/ai/src/api/changes.md";
	const PRE_EXISTING = ["packages/ai/src/api/cloudflare.ts", "packages/ai/src/api/pi-messages.ts"];
	const NEW_PR_FILE = "packages/ai/src/api/lazy.ts";
	const inventory = [...PRE_EXISTING, NEW_PR_FILE];

	it("reports uncovered when a new nearest tracker lists only some of the files beneath it", () => {
		const result = auditRepository(inventory, {
			trackerDiffs: {
				[AI_SRC_TRACKER]: [trackerEntry([...PRE_EXISTING])],
				// senpi#2895's shape: the new tracker covers only the file its PR added,
				// so the pre-existing files its parent covered turn uncovered.
				[API_TRACKER]: [trackerEntry([NEW_PR_FILE])],
			},
		});
		assert.equal(result.pass, false, "hidden previously-covered paths must fail the audit");
		assert.deepEqual(
			result.uncovered,
			[...PRE_EXISTING],
			"the exact nearest tracker shadows the parent: its unlisted paths are uncovered",
		);
		assert.match(result.reason, /changes\.md coverage missing/, "failure names changes.md coverage");
	});
});
