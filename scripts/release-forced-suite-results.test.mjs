#!/usr/bin/env node
// senpi#6642 MUST 3: the release job's YAML gate is backed by a second gate outside YAML. Every forced-suite matrix job
// uploads a result file, and release.mjs --tested-sha refuses to stamp unless all N+1 are present, passed, and name the
// commit it releases. Release contract.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FORCED_SHARD_JOBS } from "./release-forced-test-suite.mjs";
import {
	assertForcedSuiteResults,
	FORCED_SUITE_PARTS,
	forcedSuiteResultFile,
	writeForcedSuiteResult,
} from "./release-forced-suite-results.mjs";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

function withResults(mutate) {
	const dir = mkdtempSync(join(tmpdir(), "forced-results-"));
	try {
		for (const part of FORCED_SUITE_PARTS) {
			writeForcedSuiteResult(dir, { testedSha: SHA, part, exitCode: 0, files: 3, tests: 12 });
		}
		mutate?.(dir);
		return assertForcedSuiteResults({ dir, testedSha: SHA });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const rewrite = (dir, id, change) => {
	const file = join(dir, forcedSuiteResultFile(id));
	const body = JSON.parse(readFileSync(file, "utf8"));
	writeFileSync(file, JSON.stringify({ ...body, ...change }));
};

describe("forced-suite result files (senpi#6642 MUST 3)", () => {
	it("expects exactly the rest job plus coding-agent shards 1..N, N the suite's shard-job count", () => {
		assert.equal(FORCED_SHARD_JOBS, 6);
		assert.deepEqual(
			FORCED_SUITE_PARTS.map((part) => part.id),
			["rest", ...Array.from({ length: FORCED_SHARD_JOBS }, (_, index) => `coding-agent-${index + 1}`)],
		);
	});

	it("accepts all N+1 passing results for the released commit", () => {
		const accepted = withResults();
		assert.equal(accepted.length, FORCED_SHARD_JOBS + 1);
	});

	it("refuses when one shard's result file is missing (a dropped or never-run shard)", () => {
		assert.throws(
			() => withResults((dir) => unlinkSync(join(dir, forcedSuiteResultFile("coding-agent-4")))),
			/coding-agent-4/,
		);
	});

	it("refuses when the rest job's result file is missing", () => {
		assert.throws(() => withResults((dir) => unlinkSync(join(dir, forcedSuiteResultFile("rest")))), /rest/);
	});

	it("refuses a result that tested a different commit", () => {
		assert.throws(() => withResults((dir) => rewrite(dir, "coding-agent-2", { tested_sha: OTHER })), /bbbbbbbbbbbb/);
	});

	it("refuses a result whose shard numbering does not match its file", () => {
		assert.throws(() => withResults((dir) => rewrite(dir, "coding-agent-2", { shard: 3 })), /coding-agent-2/);
		assert.throws(() => withResults((dir) => rewrite(dir, "coding-agent-2", { of: 5 })), /coding-agent-2/);
	});

	it("refuses a failed result", () => {
		assert.throws(() => withResults((dir) => rewrite(dir, "rest", { exit: 1 })), /exit 1/);
	});

	it("refuses a result that ran no tests", () => {
		assert.throws(() => withResults((dir) => rewrite(dir, "coding-agent-6", { tests: 0 })), /no tests/);
	});

	it("refuses an unreadable result file", () => {
		assert.throws(
			() => withResults((dir) => writeFileSync(join(dir, forcedSuiteResultFile("coding-agent-1")), "{not json")),
			/coding-agent-1/,
		);
	});
});
