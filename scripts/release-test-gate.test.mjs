#!/usr/bin/env node
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogChangedSinceHead, decideTestGate, isCiCheckGreen } from "./release-test-gate.mjs";

const CHECK_NAME = "Check and test";

describe("isCiCheckGreen", () => {
	it("accepts a completed success check for the exact HEAD sha", () => {
		assert.equal(
			isCiCheckGreen(
				[{ name: CHECK_NAME, status: "completed", conclusion: "success", head_sha: "abc123" }],
				"abc123",
			),
			true,
		);
	});

	it("rejects a check whose sha does not match HEAD", () => {
		assert.equal(
			isCiCheckGreen(
				[{ name: CHECK_NAME, status: "completed", conclusion: "success", head_sha: "other" }],
				"abc123",
			),
			false,
		);
	});

	it("rejects in-progress and failed checks", () => {
		assert.equal(
			isCiCheckGreen(
				[{ name: CHECK_NAME, status: "in_progress", conclusion: null, head_sha: "abc123" }],
				"abc123",
			),
			false,
		);
		assert.equal(
			isCiCheckGreen(
				[{ name: CHECK_NAME, status: "completed", conclusion: "failure", head_sha: "abc123" }],
				"abc123",
			),
			false,
		);
	});

	it("rejects when the required check is absent entirely", () => {
		assert.equal(isCiCheckGreen([], "abc123"), false);
		assert.equal(
			isCiCheckGreen(
				[{ name: "Other job", status: "completed", conclusion: "success", head_sha: "abc123" }],
				"abc123",
			),
			false,
		);
	});
});

describe("decideTestGate", () => {
	const greenChecks = [{ name: CHECK_NAME, status: "completed", conclusion: "success", head_sha: "abc123" }];

	it("skips when HEAD already has a green Check and test run", () => {
		const decision = decideTestGate({ forceTests: false, dryRun: false, sha: "abc123", checkRuns: greenChecks });
		assert.equal(decision.skip, true);
		assert.match(decision.reason, /abc123/);
	});

	it("runs tests when --force-tests is given even with green CI", () => {
		const decision = decideTestGate({ forceTests: true, dryRun: false, sha: "abc123", checkRuns: greenChecks });
		assert.equal(decision.skip, false);
		assert.match(decision.reason, /force-tests/);
	});

	it("runs tests when check lookup failed (null = error/unavailable)", () => {
		const decision = decideTestGate({ forceTests: false, dryRun: false, sha: "abc123", checkRuns: null });
		assert.equal(decision.skip, false);
	});

	it("runs tests when the check is not green", () => {
		const decision = decideTestGate({
			forceTests: false,
			dryRun: false,
			sha: "abc123",
			checkRuns: [{ name: CHECK_NAME, status: "completed", conclusion: "failure", head_sha: "abc123" }],
		});
		assert.equal(decision.skip, false);
	});

	// senpi#2645: HEAD's green CI ran on the catalog before the release regenerated it.
	it("runs the full suite when the regeneration changed the catalog, even with green CI on HEAD", () => {
		const decision = decideTestGate({ forceTests: false, dryRun: false, sha: "abc123", checkRuns: greenChecks, catalogChanged: true });
		assert.equal(decision.skip, false);
		assert.match(decision.reason, /catalog/);
	});

	it("still skips on green CI when the regeneration left the catalog unchanged", () => {
		const decision = decideTestGate({ forceTests: false, dryRun: false, sha: "abc123", checkRuns: greenChecks, catalogChanged: false });
		assert.equal(decision.skip, true);
	});

	it("never skips in dry-run mode (preview stays a preview of the real gate)", () => {
		const decision = decideTestGate({ forceTests: false, dryRun: true, sha: "abc123", checkRuns: greenChecks });
		assert.equal(decision.skip, false);
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
});
