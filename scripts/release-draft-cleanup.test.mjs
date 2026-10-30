#!/usr/bin/env node

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
	cleanupFakes,
	fakeBin,
	runScript,
} from "./build-binaries-release-recovery.test-support.mjs";

const cleanupScript = fileURLToPath(
	new URL("./release-draft-cleanup.sh", import.meta.url),
);

afterEach(cleanupFakes);

const NPM_E404 = `echo "$*" >> "$LOG"\necho "npm error code E404" >&2\nexit 1`;
const NPM_HAS_IT = `echo "$*" >> "$LOG"\necho 2026.10.24-1`;
const NPM_EMPTY = `echo "$*" >> "$LOG"`;

/**
 * A draft release exists; `gh run view` answers FAKE_RUN_VIEW (exit FAKE_RUN_VIEW_EXIT) and
 * `gh run list` answers FAKE_RUN_LIST (exit FAKE_RUN_LIST_EXIT).
 */
function fakeGh() {
	return fakeBin(
		"gh",
		`echo "$*" >> "$LOG"
case "$1 $2" in
  "release view") echo true ;;
  "release delete") exit 0 ;;
  "run view") echo "\${FAKE_RUN_VIEW:-}"; exit "\${FAKE_RUN_VIEW_EXIT:-0}" ;;
  "run list") echo "\${FAKE_RUN_LIST:-0}"; exit "\${FAKE_RUN_LIST_EXIT:-0}" ;;
  *) exit 2 ;;
esac`,
	);
}

function cleanup(npmBody, env = {}) {
	const gh = fakeGh();
	const npm = fakeBin("npm", npmBody);
	const result = runScript(cleanupScript, {
		GH_BIN: gh.path,
		NPM_BIN: npm.path,
		RELEASE_TAG: "v2026.10.24-1",
		PUBLISH_RUN_ID: "",
		PUBLISH_JOB_RESULT: "",
		...env,
	});
	const output = result.stdout + result.stderr;
	const deleted = gh.calls().includes("release delete v2026.10.24-1 --yes");
	return { result, output, deleted, gh, npm };
}

function assertKept({ result, output, deleted, gh }) {
	assert.equal(result.status, 1, output);
	assert.equal(deleted, false, gh.calls().join("\n"));
}

function assertDeleted({ result, output, deleted, gh }) {
	assert.equal(result.status, 0, output);
	assert.equal(deleted, true, gh.calls().join("\n"));
}

describe("release-draft-cleanup.sh: npm side (senpi#4173)", () => {
	it("keeps the draft and exits non-zero when npm already has the version", () => {
		const outcome = cleanup(NPM_HAS_IT, { PUBLISH_JOB_RESULT: "failure" });
		assertKept(outcome);
		assert.deepEqual(outcome.npm.calls(), [
			"view @code-yeongyu/senpi@2026.10.24-1 version",
		]);
		assert.match(
			outcome.output,
			/gh release edit v2026\.10\.24-1 --draft=false/,
		);
	});

	it("keeps the draft when the npm lookup itself fails", () => {
		const outcome = cleanup(`echo "npm error code ETIMEDOUT" >&2\nexit 1`);
		assertKept(outcome);
		assert.match(
			outcome.output,
			/Could not determine whether npm has @code-yeongyu\/senpi@2026\.10\.24-1/,
		);
	});

	it("deletes the draft on E404 when no publish run was dispatched", () => {
		assertDeleted(cleanup(NPM_E404, { PUBLISH_JOB_RESULT: "skipped" }));
	});

	it("deletes the draft on an empty npm view result when no publish run was dispatched", () => {
		assertDeleted(cleanup(NPM_EMPTY, { PUBLISH_JOB_RESULT: "skipped" }));
	});
});

describe("release-draft-cleanup.sh: dispatched publish run (senpi#4173)", () => {
	for (const state of ["queued ", "in_progress ", "waiting ", "pending "]) {
		it(`keeps the draft while the dispatched run is ${state.trim()}`, () => {
			const outcome = cleanup(NPM_E404, {
				PUBLISH_JOB_RESULT: "failure",
				PUBLISH_RUN_ID: "77",
				FAKE_RUN_VIEW: state,
			});
			assertKept(outcome);
			assert.ok(outcome.gh.calls().some((c) => c.startsWith("run view 77")));
			assert.match(outcome.output, /gh run view 77/);
			assert.match(outcome.output, /gh release edit v2026\.10\.24-1 --draft=false/);
		});
	}

	it("keeps the draft when the dispatched run's status cannot be read", () => {
		assertKept(
			cleanup(NPM_E404, {
				PUBLISH_JOB_RESULT: "failure",
				PUBLISH_RUN_ID: "77",
				FAKE_RUN_VIEW_EXIT: "1",
			}),
		);
	});

	it("keeps the draft when the run succeeded but npm does not show the version yet", () => {
		assertKept(
			cleanup(NPM_E404, {
				PUBLISH_JOB_RESULT: "failure",
				PUBLISH_RUN_ID: "77",
				FAKE_RUN_VIEW: "completed success",
			}),
		);
	});

	it("deletes the draft when the dispatched run completed without success", () => {
		for (const conclusion of ["failure", "cancelled"]) {
			assertDeleted(
				cleanup(NPM_E404, {
					PUBLISH_JOB_RESULT: "failure",
					PUBLISH_RUN_ID: "77",
					FAKE_RUN_VIEW: `completed ${conclusion}`,
				}),
			);
		}
	});

	it("without a run id, keeps the draft while a publish-npm.yml dispatch is still in flight", () => {
		const outcome = cleanup(NPM_E404, {
			PUBLISH_JOB_RESULT: "cancelled",
			FAKE_RUN_LIST: "1",
		});
		assertKept(outcome);
		assert.ok(
			outcome.gh.calls().some((c) =>
				c.startsWith("run list --workflow publish-npm.yml --event workflow_dispatch"),
			),
			outcome.gh.calls().join("\n"),
		);
	});

	it("without a run id, keeps the draft when the publish runs cannot be listed", () => {
		assertKept(
			cleanup(NPM_E404, {
				PUBLISH_JOB_RESULT: "cancelled",
				FAKE_RUN_LIST_EXIT: "1",
			}),
		);
	});

	it("without a run id, deletes the draft when no publish-npm.yml dispatch is in flight", () => {
		assertDeleted(
			cleanup(NPM_E404, { PUBLISH_JOB_RESULT: "failure", FAKE_RUN_LIST: "0" }),
		);
	});
});
