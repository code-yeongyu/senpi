#!/usr/bin/env node
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkPrChangelog } from "./check-pr-changelog.mjs";

// Failing-first spec for the changes.md tracker policy. AGENTS.md requires
// every edit to upstream-owned production source to update the nearest
// changes.md in the same increment, with all four canonical sections. These
// tests pass a new optional `trackerPolicy` input to the existing
// checkPrChangelog seam:
//   - forkOnly: production files added by the fork (no upstream counterpart)
//   - trackerDiffs: parsed changes.md diffs per tracker path; each entry lists
//     the files it covers and the canonical section headings it carries
//   - renames / deletions: change-kind records for rename/delete handling
//   - upstreamSync: pin-change sync info; divergentFiles are production edits
//     that differ from the new pin (integration repairs)
// Production files not listed in forkOnly are upstream-owned by default.

const CANONICAL_SECTIONS = [
	"What changed",
	"Why",
	"Why an extension could not handle it",
	"Expected merge conflict zones",
];

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

describe("check-pr-changelog changes.md tracker policy", () => {
	it("fails an upstream-owned production edit with no nearest changes.md even under no-changelog", () => {
		const result = checkPrChangelog({
			changedFiles: ["packages/ai/src/index.ts"],
			labels: ["no-changelog"],
			trackerPolicy: trackerPolicy(),
		});
		assert.equal(
			result.pass,
			false,
			"upstream-owned production edits must fail without the nearest changes.md even with the no-changelog label",
		);
		assert.match(result.reason, /changes\.md/, "failure reason must name the missing changes.md tracker");
	});

	it("passes when the exact nearest changes.md adds all four canonical sections", () => {
		const source = "packages/coding-agent/src/core/extensions/builtin/senpi-tool.ts";
		const result = checkPrChangelog({
			changedFiles: [source, "packages/coding-agent/src/core/extensions/builtin/changes.md"],
			labels: ["no-changelog"],
			trackerPolicy: trackerPolicy({
				trackerDiffs: {
					"packages/coding-agent/src/core/extensions/builtin/changes.md": [trackerEntry([source])],
				},
			}),
		});
		assert.equal(result.pass, true, "nearest changes.md with all four canonical sections should pass");
		assert.match(result.reason, /changes\.md/);
	});

	it("keeps the release CHANGELOG requirement independent from changes.md coverage", () => {
		const source = "packages/ai/src/index.ts";
		const result = checkPrChangelog({
			changedFiles: [source, "packages/ai/src/changes.md"],
			labels: [],
			trackerPolicy: trackerPolicy({
				trackerDiffs: { "packages/ai/src/changes.md": [trackerEntry([source])] },
			}),
		});
		assert.equal(result.pass, false, "changes.md coverage must not replace the package CHANGELOG requirement");
		assert.match(result.reason, /CHANGELOG\.md/, "failure reason must preserve the release changelog verdict");
	});

	it("fails when only a non-nearest changes.md is touched", () => {
		const result = checkPrChangelog({
			changedFiles: ["packages/ai/src/index.ts", "packages/tui/changes.md"],
			labels: ["no-changelog"],
			trackerPolicy: trackerPolicy({
				trackerDiffs: { "packages/tui/changes.md": [trackerEntry(["packages/ai/src/index.ts"])] },
			}),
		});
		assert.equal(result.pass, false, "a changes.md other than the nearest tracker must not satisfy the gate");
		assert.match(result.reason, /nearest changes\.md/, "failure reason must name the nearest changes.md tracker");
	});

	it("passes a genuinely fork-only added source file without a tracker touch", () => {
		const forkFile = "packages/coding-agent/src/core/fork/senpi-branding.ts";
		const result = checkPrChangelog({
			changedFiles: [forkFile],
			labels: ["no-changelog"],
			trackerPolicy: trackerPolicy({ forkOnly: [forkFile] }),
		});
		assert.equal(result.pass, true, "fork-only source additions do not require an upstream changes.md entry");
	});

	it("passes docs, tests, and generated-catalog-only changes under the tracker policy", () => {
		const result = checkPrChangelog({
			changedFiles: [
				"packages/ai/README.md",
				"packages/ai/src/models.generated.ts",
				"packages/ai/src/api/__tests__/openai.test.ts",
			],
			labels: [],
			trackerPolicy: trackerPolicy(),
		});
		assert.equal(result.pass, true, "non-production changes stay outside the changes.md tracker policy");
	});

	it("audits production paths across scripts workflows server and evals", () => {
		const production = [
			"scripts/release.mjs",
			".github/workflows/ci.yml",
			"packages/server/src/protocol.ts",
			"packages/evals/src/pi-harness.ts",
		];
		const result = checkPrChangelog({
			changedFiles: production,
			labels: ["no-changelog"],
			trackerPolicy: trackerPolicy(),
		});
		assert.equal(result.pass, false, "the changes.md policy spans every production area, not release packages only");
		assert.deepEqual(result.uncovered, production);
	});

	it("does not fall through an existing empty nearest tracker to a parent", () => {
		const source = "packages/ai/src/index.ts";
		const result = checkPrChangelog({
			changedFiles: [source, "packages/ai/changes.md"],
			labels: ["no-changelog"],
			trackerPolicy: trackerPolicy({
				existingTrackers: ["packages/ai/changes.md", "packages/ai/src/changes.md"],
				trackerDiffs: { "packages/ai/changes.md": [trackerEntry([source])] },
			}),
		});
		assert.equal(result.pass, false, "an unchanged or empty nearest tracker cannot be bypassed by parent coverage");
		assert.deepEqual(result.uncovered, [source]);
	});

	it("fails a malformed nearest changes.md entry missing a canonical section", () => {
		const source = "packages/ai/src/index.ts";
		const result = checkPrChangelog({
			changedFiles: [source, "packages/ai/src/changes.md"],
			labels: ["no-changelog"],
			trackerPolicy: trackerPolicy({
				trackerDiffs: {
					"packages/ai/src/changes.md": [trackerEntry([source], CANONICAL_SECTIONS.slice(0, 3))],
				},
			}),
		});
		assert.equal(result.pass, false, "changes.md entries missing a canonical section must fail the gate");
		assert.match(result.reason, /changes\.md/, "failure reason must name the malformed changes.md entry");
	});

	it("fails a stale changes.md entry that does not cover the edited file", () => {
		const result = checkPrChangelog({
			changedFiles: ["packages/ai/src/index.ts", "packages/ai/src/changes.md"],
			labels: ["no-changelog"],
			trackerPolicy: trackerPolicy({
				trackerDiffs: {
					"packages/ai/src/changes.md": [trackerEntry(["packages/ai/src/legacy-removed.ts"])],
				},
			}),
		});
		assert.equal(result.pass, false, "a changes.md entry that does not cover the edited file is stale and must fail");
		assert.match(result.reason, /changes\.md/, "failure reason must name the stale changes.md entry");
	});

	it("fails a rename of upstream-owned production source without the nearest changes.md", () => {
		const renamed = "packages/tui/src/panels/panel.ts";
		const result = checkPrChangelog({
			changedFiles: ["packages/tui/src/panel.ts", renamed],
			labels: ["no-changelog"],
			trackerPolicy: trackerPolicy({
				forkOnly: [renamed],
				renames: [{ from: "packages/tui/src/panel.ts", to: renamed }],
			}),
		});
		assert.equal(
			result.pass,
			false,
			"an upstream rename still requires changes.md even when its new destination did not exist in the pin",
		);
		assert.match(result.reason, /changes\.md/, "failure reason must name the missing changes.md tracker");
	});

	it("fails deleting upstream-owned production source without the nearest changes.md", () => {
		const deleted = "packages/agent/src/deprecated-senpi-hook.ts";
		const result = checkPrChangelog({
			changedFiles: [deleted],
			labels: ["no-changelog"],
			trackerPolicy: trackerPolicy({ deletions: [deleted] }),
		});
		assert.equal(result.pass, false, "deleting upstream-owned production source must still update the nearest changes.md");
		assert.match(result.reason, /changes\.md/, "failure reason must name the missing changes.md tracker");
	});

	it("passes deleting a fork-only file without a tracker touch", () => {
		const forkFile = "packages/coding-agent/src/fork/experiment.ts";
		const result = checkPrChangelog({
			changedFiles: [forkFile],
			labels: ["no-changelog"],
			trackerPolicy: trackerPolicy({ forkOnly: [forkFile], deletions: [forkFile] }),
		});
		assert.equal(result.pass, true, "deleting fork-only source never requires an upstream changes.md entry");
	});

	it("passes a clean upstream sync whose pin and production edits agree", () => {
		const result = checkPrChangelog({
			changedFiles: [".github/upstream.json", "packages/agent/src/agent-loop.ts", "packages/tui/src/tui.ts"],
			labels: ["no-changelog"],
			trackerPolicy: trackerPolicy({ upstreamSync: { pinChanged: true, divergentFiles: [] } }),
		});
		assert.equal(result.pass, true, "a clean pin-change sync carries upstream's own edits and needs no changes.md entry");
	});

	it("fails an integration repair that diverges from the new pin without a changes.md entry", () => {
		const result = checkPrChangelog({
			changedFiles: [".github/upstream.json", "packages/agent/src/agent-loop.ts"],
			labels: ["no-changelog"],
			trackerPolicy: trackerPolicy({
				upstreamSync: { pinChanged: true, divergentFiles: ["packages/agent/src/agent-loop.ts"] },
			}),
		});
		assert.equal(
			result.pass,
			false,
			"production edits differing from the new pin are fork repairs and require the nearest changes.md",
		);
		assert.match(result.reason, /changes\.md/, "failure reason must name the missing changes.md tracker");
	});
});
