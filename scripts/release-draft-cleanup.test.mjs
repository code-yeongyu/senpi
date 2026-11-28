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
 * `gh run list` answers FAKE_RUN_LIST (exit FAKE_RUN_LIST_EXIT); the query for runs that published the version
 * (senpi#7469, it asks for `displayTitle`) answers the raw --json rows FAKE_PUBLISHED_ROWS through the script's own
 * --jq program with real jq (exit FAKE_PUBLISHED_EXIT), so its selection predicate is what the tests exercise.
 */
function fakeGh() {
	return fakeBin(
		"gh",
		`echo "$*" >> "$LOG"
case "$1 $2" in
  "release view") echo true ;;
  "release delete") exit 0 ;;
  "run view") echo "\${FAKE_RUN_VIEW:-}"; exit "\${FAKE_RUN_VIEW_EXIT:-0}" ;;
  "run list")
    case "$*" in
      *displayTitle*)
        [ "\${FAKE_PUBLISHED_EXIT:-0}" = 0 ] || exit "\${FAKE_PUBLISHED_EXIT}"
        filter="" previous=""
        for argument in "$@"; do [ "$previous" = --jq ] && filter="$argument"; previous="$argument"; done
        jq -r "$filter" <<< "\${FAKE_PUBLISHED_ROWS:-[]}"; exit $? ;;
    esac
    echo "\${FAKE_RUN_LIST:-0}"; exit "\${FAKE_RUN_LIST_EXIT:-0}" ;;
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

	// senpi#6627: npm no longer waits for staging, so staging can fail after it created the draft while npm
	// published. That draft may lack assets: the advice must be to re-stage it, never to publish it.
	it("never advises publishing a kept draft whose staging job did not succeed, in any branch that keeps it", () => {
		const keptStates = {
			"npm has the version": [NPM_HAS_IT, { PUBLISH_JOB_RESULT: "success" }],
			"npm lookup failed": [`echo "npm error code ETIMEDOUT" >&2\nexit 1`, {}],
			"publish run still running": [NPM_E404, { PUBLISH_RUN_ID: "123", FAKE_RUN_VIEW: "in_progress" }],
			"publish run succeeded, registry lagging": [NPM_E404, { PUBLISH_RUN_ID: "123", FAKE_RUN_VIEW: "completed success" }],
			"publish run unreadable": [NPM_E404, { PUBLISH_RUN_ID: "123", FAKE_RUN_VIEW_EXIT: "1" }],
			"publish dispatch in flight": [NPM_E404, { FAKE_RUN_LIST: "1" }],
			"publish runs unlistable": [NPM_E404, { FAKE_RUN_LIST_EXIT: "1" }],
		};
		for (const [state, [npmBody, env]] of Object.entries(keptStates)) {
			for (const stage of ["failure", "cancelled"]) {
				const outcome = cleanup(npmBody, { ...env, STAGE_JOB_RESULT: stage });
				assertKept(outcome);
				assert.doesNotMatch(outcome.output, /--draft=false/, `${state}, staging ${stage}: advised publishing an unfinished draft`);
				assert.match(outcome.output, /staging did not finish/, `${state}, staging ${stage}`);
				assert.match(outcome.output, /release-assets-v2026\.10\.24-1/, `${state}, staging ${stage}`);
			}
			const staged = cleanup(npmBody, { ...env, STAGE_JOB_RESULT: "success" });
			assertKept(staged);
			assert.match(staged.output, /gh release edit v2026\.10\.24-1 --draft=false/, `${state}, staging success: lost the publish advice`);
		}
	});

	it("keeps the publish advice when staging succeeded", () => {
		const outcome = cleanup(NPM_HAS_IT, { PUBLISH_JOB_RESULT: "failure", STAGE_JOB_RESULT: "success" });
		assertKept(outcome);
		assert.match(outcome.output, /gh release edit v2026\.10\.24-1 --draft=false/);
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

	// senpi#6851: the publish run's own finalize job keeps that run in progress, so its release job's result decides.
	it("deletes the draft when the publish run's release job failed, though the run is still in progress", () => {
		const outcome = cleanup(NPM_E404, { PUBLISH_RUN_ID: "77", PUBLISH_RELEASE_RESULT: "failure", FAKE_RUN_VIEW: "in_progress " });
		assertDeleted(outcome);
		assert.ok(!outcome.gh.calls().some((c) => c.startsWith("run view")), "the release job's result decides, not the run's status");
	});

	it("keeps the draft when the publish run's release job succeeded but npm does not show the version yet", () => {
		assertKept(cleanup(NPM_E404, { PUBLISH_RUN_ID: "77", PUBLISH_RELEASE_RESULT: "success" }));
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

// senpi#7469 (2026.11.25): a manual publish-only run published every package, then Build Binaries' own publish run met
// the registry's lag on the main package, failed, and its finalize deleted the draft. The run that failed is not the
// only witness: the draft stays while any publish-npm.yml run of the version succeeded.
const run = (databaseId, displayTitle, conclusion = "success", event = "workflow_dispatch") => ({ databaseId, displayTitle, conclusion, event });
const rows = (...list) => JSON.stringify(list);

describe("release-draft-cleanup.sh: another run published the version (senpi#7469)", () => {
	it("keeps the draft when this publish run failed on registry lag but another run of the version succeeded", () => {
		const outcome = cleanup(NPM_E404, {
			PUBLISH_RUN_ID: "45679166975",
			PUBLISH_JOB_RESULT: "success",
			PUBLISH_RELEASE_RESULT: "failure",
			FAKE_PUBLISHED_ROWS: rows(run(45678655590, "Release 2026.10.24-1 publish-only")),
		});
		assertKept(outcome);
		assert.match(outcome.output, /publish-npm\.yml run\(s\) 45678655590 published 2026\.10\.24-1/);
		assert.ok(
			outcome.gh.calls().some((call) => call.startsWith("run list --workflow publish-npm.yml") && call.includes("displayTitle")),
			outcome.gh.calls().join("\n"),
		);
	});

	// senpi#7469 (2026.11.28-1): Build Binaries dispatched the publish run but its find step gave up before the run showed
	// up in the API, so the run id is unknown here; that run had already published every package and npm still lagged.
	it("keeps the draft when the publish run id is unknown and a publish-only run of the version already succeeded", () => {
		const outcome = cleanup(NPM_E404, {
			PUBLISH_RUN_ID: "",
			PUBLISH_JOB_RESULT: "failure",
			FAKE_RUN_LIST: "0",
			FAKE_PUBLISHED_ROWS: rows(run(46103796424, "Release 2026.10.24-1 publish-only")),
		});
		assertKept(outcome);
		assert.match(outcome.output, /publish-npm\.yml run\(s\) 46103796424 published 2026\.10\.24-1/);
	});

	it("deletes the draft when the publish run id is unknown, nothing is in flight and no publish run of the version succeeded", () => {
		assertDeleted(cleanup(NPM_E404, { PUBLISH_RUN_ID: "", PUBLISH_JOB_RESULT: "failure", FAKE_RUN_LIST: "0", FAKE_PUBLISHED_ROWS: rows() }));
	});

	it("keeps the draft when the runs that could have published the version cannot be listed", () => {
		assertKept(
			cleanup(NPM_E404, { PUBLISH_RUN_ID: "45679166975", PUBLISH_JOB_RESULT: "success", PUBLISH_RELEASE_RESULT: "failure", FAKE_PUBLISHED_EXIT: "1" }),
		);
	});

	it("deletes the draft only when npm lacks the version and no publish run of it succeeded", () => {
		assertDeleted(
			cleanup(NPM_E404, { PUBLISH_RUN_ID: "45679166975", PUBLISH_JOB_RESULT: "success", PUBLISH_RELEASE_RESULT: "failure", FAKE_PUBLISHED_ROWS: rows() }),
		);
	});

	it("deletes the draft when the only successful runs of the version are the stamp run, a dry run or a failed publish", () => {
		const outcome = cleanup(NPM_E404, {
			PUBLISH_RUN_ID: "45679166975",
			PUBLISH_JOB_RESULT: "success",
			PUBLISH_RELEASE_RESULT: "failure",
			FAKE_PUBLISHED_ROWS: rows(
				run(45677509583, "Release 2026.10.24-1"),
				run(45677509584, "Release 2026.10.24-1 publish-only dry-run"),
				run(45679166975, "Release 2026.10.24-1 publish-only", "failure"),
				run(45677509585, "Release 2026.10.24-10 publish-only"),
			),
		});
		assertDeleted(outcome);
		assert.doesNotMatch(outcome.output, /published 2026\.10\.24-1/);
	});
});
