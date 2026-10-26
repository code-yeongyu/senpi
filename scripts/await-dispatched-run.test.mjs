#!/usr/bin/env node

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	cleanupFakes,
	fakeGhSequence,
	runScript,
} from "./build-binaries-release-recovery.test-support.mjs";

const awaitScript = fileURLToPath(
	new URL("./await-dispatched-run.sh", import.meta.url),
);

afterEach(cleanupFakes);

function awaitRun(gh, overrides = {}) {
	return runScript(awaitScript, {
		GH_BIN: gh.path,
		RUN_ID: "42",
		AWAIT_INTERVAL: "0",
		AWAIT_MAX_SECONDS: "60",
		...overrides,
	});
}

describe("await-dispatched-run.sh (senpi#4173)", () => {
	it("keeps waiting through queued and in_progress, then exits 0 on success", () => {
		const gh = fakeGhSequence([
			"queued ",
			"queued ",
			"in_progress ",
			"completed success",
		]);
		const result = awaitRun(gh);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.equal(gh.calls().length, 4);
		assert.ok(gh.calls().every((call) => call.startsWith("run view 42")));
		assert.match(result.stdout, /queued/);
		assert.match(result.stdout, /in_progress/);
	});

	it("exits 1 when the child run completes with a failure conclusion", () => {
		const gh = fakeGhSequence(["in_progress ", "completed failure"]);
		const result = awaitRun(gh);
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.match(result.stdout + result.stderr, /failure/);
	});

	it("exits 1 with a clear message when the child never completes within AWAIT_MAX_SECONDS", () => {
		const gh = fakeGhSequence(["queued "]);
		const result = awaitRun(gh, { AWAIT_INTERVAL: "1", AWAIT_MAX_SECONDS: "2" });
		assert.equal(result.status, 1, result.stdout + result.stderr);
		assert.match(
			result.stdout + result.stderr,
			/did not complete within 2 seconds/,
		);
		assert.ok(gh.calls().length >= 2);
	});

	it("parses only stdout when gh also writes a notice to stderr", () => {
		const gh = fakeGhSequence([
			{ stdout: "completed success", stderr: "A new release of gh is available" },
		]);
		const result = awaitRun(gh, { AWAIT_MAX_SECONDS: "0" });
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.equal(gh.calls().length, 1);
	});

	it("retries a transient gh error and reports it, then follows the run to success", () => {
		const gh = fakeGhSequence([
			{ stderr: "HTTP 502: Bad Gateway", exit: 1 },
			"in_progress ",
			"completed success",
		]);
		const result = awaitRun(gh);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.equal(gh.calls().length, 3);
		assert.match(
			result.stdout,
			/::warning::Could not read the status of run 42; retrying: HTTP 502: Bad Gateway/,
		);
	});
});
