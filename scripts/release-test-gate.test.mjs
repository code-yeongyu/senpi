#!/usr/bin/env node
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	awaitCiEvidence,
	CATALOG_MANIFEST,
	catalogChangedSinceHead,
	discardTimestampOnlyCatalogChange,
	isTimestampOnlyManifestChange,
	planCiEvidence,
} from "./release-test-gate.mjs";

const CHECK_NAME = "Check and test";

const checkRun = (sha, status, conclusion = null) => ({ name: CHECK_NAME, status, conclusion, head_sha: sha });
// What CI really reports when a newer push cancels the run: the `always()` fan-in still runs and fails, while the
// workflow run itself concludes `cancelled` (main runs 37744186393 and 37741990289).
const supersededFanIn = (sha) => ({ ...checkRun(sha, "completed", "failure"), workflowStatus: "completed", workflowConclusion: "cancelled" });

describe("planCiEvidence (senpi#2943)", () => {
	it("reuses a green Check and test run on the exact sha", () => {
		assert.equal(planCiEvidence({ sha: "c1", checkRuns: [checkRun("c1", "completed", "success")] }).action, "reuse");
	});

	it("waits while the run is queued or in progress, or not registered yet", () => {
		assert.equal(planCiEvidence({ sha: "c1", checkRuns: [checkRun("c1", "in_progress")] }).action, "wait");
		assert.equal(planCiEvidence({ sha: "c1", checkRuns: [checkRun("c1", "queued")] }).action, "wait");
		assert.equal(planCiEvidence({ sha: "c1", checkRuns: [] }).action, "wait");
		assert.equal(planCiEvidence({ sha: "c1", checkRuns: null }).action, "wait");
	});

	it("stops on a red run: the release must not ship what CI rejected", () => {
		assert.equal(planCiEvidence({ sha: "c1", checkRuns: [checkRun("c1", "completed", "failure")] }).action, "stop");
		assert.equal(planCiEvidence({ sha: "c1", checkRuns: [checkRun("c1", "completed", "timed_out")] }).action, "stop");
	});

	it("treats a failed fan-in inside a cancelled workflow run as superseded, the shape a newer push produces", () => {
		assert.equal(planCiEvidence({ sha: "c1", checkRuns: [supersededFanIn("c1")] }).action, "superseded");
	});

	it("stops on a failed fan-in inside a failed workflow run", () => {
		const checkRuns = [{ ...checkRun("c1", "completed", "failure"), workflowStatus: "completed", workflowConclusion: "failure" }];
		assert.equal(planCiEvidence({ sha: "c1", checkRuns }).action, "stop");
	});

	it("waits while the failed fan-in's workflow run is still finishing, so a cancellation is not mistaken for red CI", () => {
		const checkRuns = [{ ...checkRun("c1", "completed", "failure"), workflowStatus: "in_progress", workflowConclusion: null }];
		assert.equal(planCiEvidence({ sha: "c1", checkRuns }).action, "wait");
	});

	it("treats a skipped fan-in as superseded and a neutral one as a stop, never as evidence", () => {
		assert.equal(planCiEvidence({ sha: "c1", checkRuns: [checkRun("c1", "completed", "skipped")] }).action, "superseded");
		assert.equal(planCiEvidence({ sha: "c1", checkRuns: [checkRun("c1", "completed", "neutral")] }).action, "stop");
		assert.equal(planCiEvidence({ sha: "c1", checkRuns: [checkRun("c1", "completed", "action_required")] }).action, "stop");
	});

	it("treats a cancelled run as superseded, not as evidence", () => {
		assert.equal(planCiEvidence({ sha: "c1", checkRuns: [checkRun("c1", "completed", "cancelled")] }).action, "superseded");
	});

	it("ignores a green run for another sha", () => {
		assert.equal(planCiEvidence({ sha: "c1", checkRuns: [checkRun("c0", "completed", "success")] }).action, "wait");
	});

	it("uses the newest run when CI ran more than once on the sha", () => {
		const checkRuns = [checkRun("c1", "completed", "failure"), checkRun("c1", "completed", "success")];
		assert.equal(planCiEvidence({ sha: "c1", checkRuns }).action, "reuse");
	});
});

function world({ heads = ["c1"], runs = {}, timeline = [], mainTip, mainAncestors } = {}) {
	let now = 0;
	let head = heads[0];
	const calls = { merges: [], sleeps: 0 };
	return {
		calls,
		deps: {
			lookupCheckRuns: (sha) => {
				const step = timeline.find((entry) => entry.sha === sha && entry.at <= now && (entry.until ?? Infinity) > now);
				return step ? step.runs : (runs[sha] ?? []);
			},
			sleep: () => {
				calls.sleeps += 1;
				if (calls.sleeps > 500) throw new Error("test fake: the wait loop never ended");
				now += 30_000;
			},
			now: () => now,
			headSha: () => head,
			remoteMain: () => {
				const tip = mainTip ?? heads[heads.length - 1];
				const ancestors = mainAncestors ?? heads;
				return { tip, contains: (sha) => ancestors.includes(sha) };
			},
			fastForwardTo: (sha) => {
				calls.merges.push(sha);
				head = sha;
			},
			log: () => {},
		},
	};
}

describe("awaitCiEvidence (senpi#2943)", () => {
	it("returns at once on green CI for HEAD, with no local suite and no waiting", () => {
		const { deps, calls } = world({ runs: { c1: [checkRun("c1", "completed", "success")] } });
		assert.equal(awaitCiEvidence({ timeoutMs: 600_000, pollMs: 30_000 }, deps), "c1");
		assert.equal(calls.sleeps, 0);
	});

	it("waits for a pushed catalog commit's CI and returns once it turns green", () => {
		const { deps, calls } = world({
			timeline: [
				{ sha: "c1", at: 0, until: 60_000, runs: [] },
				{ sha: "c1", at: 60_000, until: 120_000, runs: [checkRun("c1", "in_progress")] },
				{ sha: "c1", at: 120_000, runs: [checkRun("c1", "completed", "success")] },
			],
		});
		assert.equal(awaitCiEvidence({ timeoutMs: 600_000, pollMs: 30_000 }, deps), "c1");
		assert.equal(calls.sleeps, 4);
	});

	it("stops the release when CI is red on the catalog commit", () => {
		const { deps } = world({ runs: { c1: [checkRun("c1", "completed", "failure")] } });
		assert.throws(() => awaitCiEvidence({ timeoutMs: 600_000, pollMs: 30_000 }, deps), /CI failed on c1/);
	});

	it("follows main forward when a newer push superseded the run, and the release continues on the commit it tested", () => {
		// The catalog commit c1 was pushed; another push (c2, on top of c1) cancelled c1's CI.
		const { deps, calls } = world({
			heads: ["c1", "c2"],
			runs: { c1: [supersededFanIn("c1")], c2: [checkRun("c2", "completed", "success")] },
		});
		assert.equal(awaitCiEvidence({ timeoutMs: 600_000, pollMs: 30_000 }, deps), "c2");
		assert.deepEqual(calls.merges, ["c2"]);
		// The release tags on top of HEAD, which is now exactly the commit whose CI is green.
		assert.equal(deps.headSha(), "c2");
	});

	it("never follows a moved main that does not contain the catalog commit", () => {
		// main moved to x9, a history that lacks c1 (rewritten or reset), and c1's CI was cancelled.
		const { deps, calls } = world({
			heads: ["c1"],
			mainTip: "x9",
			mainAncestors: ["x9"],
			runs: { c1: [supersededFanIn("c1")], x9: [checkRun("x9", "completed", "success")] },
		});
		assert.throws(
			() => awaitCiEvidence({ timeoutMs: 600_000, pollMs: 30_000 }, deps),
			/main moved to x9, which does not contain c1/,
		);
		assert.deepEqual(calls.merges, []);
	});

	it("follows a moved main only through commits whose own CI is green", () => {
		// c2 superseded c1, then c3 superseded c2; c3 is red, so the release stops rather than tagging c3 or c1.
		const { deps, calls } = world({
			heads: ["c1", "c2", "c3"],
			runs: {
				c1: [supersededFanIn("c1")],
				c3: [{ ...checkRun("c3", "completed", "failure"), workflowStatus: "completed", workflowConclusion: "failure" }],
			},
		});
		assert.throws(() => awaitCiEvidence({ timeoutMs: 600_000, pollMs: 30_000 }, deps), /CI failed on c3/);
		assert.deepEqual(calls.merges, ["c3"]);
	});

	it("keeps waiting on a cancelled run while main has not moved, so a CI rerun can still prove the commit", () => {
		const { deps, calls } = world({
			timeline: [
				{ sha: "c1", at: 0, until: 60_000, runs: [supersededFanIn("c1")] },
				{ sha: "c1", at: 60_000, runs: [{ ...checkRun("c1", "completed", "success"), id: 2 }] },
			],
		});
		assert.equal(awaitCiEvidence({ timeoutMs: 600_000, pollMs: 30_000 }, deps), "c1");
		assert.deepEqual(calls.merges, []);
	});

	it("fails with a clear message instead of running the suite serially when no evidence arrives in time", () => {
		const { deps } = world({ runs: { c1: [] } });
		assert.throws(
			() => awaitCiEvidence({ timeoutMs: 90_000, pollMs: 30_000 }, deps),
			/no Check and test result for c1 within 2 min/,
		);
	});
});

const manifest = (generatedAt, hash) =>
	`${JSON.stringify({ schemaVersion: 6, generatedAt, structureHash: "s", files: { "nvidia.json": hash } })}\n`;

describe("isTimestampOnlyManifestChange (senpi#2943)", () => {
	it("is true when only generatedAt moved", () => {
		assert.equal(isTimestampOnlyManifestChange(manifest("2026-10-01T00:00:00Z", "h1"), manifest("2026-10-08T00:00:00Z", "h1")), true);
	});

	it("is false when a file hash changed", () => {
		assert.equal(isTimestampOnlyManifestChange(manifest("2026-10-01T00:00:00Z", "h1"), manifest("2026-10-08T00:00:00Z", "h2")), false);
	});
});

describe("catalogChangedSinceHead (senpi#2645)", () => {
	const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
	function repoWithCatalog() {
		const root = mkdtempSync(join(tmpdir(), "senpi-release-gate-"));
		git(root, "init", "-q");
		git(root, "config", "user.email", "gate@example.invalid");
		git(root, "config", "user.name", "gate");
		mkdirSync(join(root, "packages/ai/src/providers/data"), { recursive: true });
		writeFileSync(join(root, "packages/ai/src/models.generated.ts"), "export const MODELS = {};\n");
		writeFileSync(join(root, "packages/ai/src/providers/data/nvidia.json"), '{"a":1}\n');
		writeFileSync(join(root, CATALOG_MANIFEST), manifest("2026-10-01T00:00:00.000Z", "h1"));
		writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n");
		git(root, "add", "-A");
		git(root, "commit", "-q", "-m", "base");
		return root;
	}

	it("is false when the regeneration left every catalog file as HEAD has it", () => {
		const root = repoWithCatalog();
		try {
			writeFileSync(join(root, "CHANGELOG.md"), "# Changelog\n\n## [1.0.0]\n");
			assert.equal(catalogChangedSinceHead(root), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("is true when the regeneration rewrote a provider's catalog data", () => {
		const root = repoWithCatalog();
		try {
			writeFileSync(join(root, "packages/ai/src/providers/data/nvidia.json"), '{"b":2}\n');
			assert.equal(catalogChangedSinceHead(root), true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("is true when the regeneration added a new provider's catalog file", () => {
		const root = repoWithCatalog();
		try {
			writeFileSync(join(root, "packages/ai/src/providers/data/newprovider.json"), '{"c":3}\n');
			assert.equal(catalogChangedSinceHead(root), true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("treats a regeneration that only re-stamped the manifest as unchanged, and restores HEAD's manifest", () => {
		const root = repoWithCatalog();
		try {
			writeFileSync(join(root, CATALOG_MANIFEST), manifest("2026-10-08T09:00:00.000Z", "h1"));
			assert.equal(discardTimestampOnlyCatalogChange(root), true);
			assert.equal(catalogChangedSinceHead(root), false);
			assert.equal(readFileSync(join(root, CATALOG_MANIFEST), "utf8"), manifest("2026-10-01T00:00:00.000Z", "h1"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps a manifest change that came with real catalog drift", () => {
		const root = repoWithCatalog();
		try {
			writeFileSync(join(root, "packages/ai/src/providers/data/nvidia.json"), '{"b":2}\n');
			writeFileSync(join(root, CATALOG_MANIFEST), manifest("2026-10-08T09:00:00.000Z", "h2"));
			assert.equal(discardTimestampOnlyCatalogChange(root), false);
			assert.equal(catalogChangedSinceHead(root), true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps a manifest-only change that is more than the stamp", () => {
		const root = repoWithCatalog();
		try {
			writeFileSync(join(root, CATALOG_MANIFEST), manifest("2026-10-08T09:00:00.000Z", "h9"));
			assert.equal(discardTimestampOnlyCatalogChange(root), false);
			assert.equal(catalogChangedSinceHead(root), true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
