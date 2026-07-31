#!/usr/bin/env node
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideTestGate, isCiCheckGreen } from "./release-test-gate.mjs";

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

	it("never skips in dry-run mode (preview stays a preview of the real gate)", () => {
		const decision = decideTestGate({ forceTests: false, dryRun: true, sha: "abc123", checkRuns: greenChecks });
		assert.equal(decision.skip, false);
	});
});
