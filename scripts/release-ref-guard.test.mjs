#!/usr/bin/env node
// senpi#6645 review (32e83a5610, finding 1): a second lock in code, independent of the workflow's step conditions and
// of the --dry-run flag's plumbing: inside GitHub Actions, release.mjs and publish.mjs refuse a run that is not a dry
// run unless the dispatched ref is refs/heads/main. Local runs (no GITHUB_ACTIONS) are unaffected. Release contract.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertLiveRunOnMain } from "./release-ref-guard.mjs";

const actions = (ref) => ({ GITHUB_ACTIONS: "true", ...(ref === undefined ? {} : { GITHUB_REF: ref }) });

describe("assertLiveRunOnMain", () => {
	it("refuses a live run in GitHub Actions on a branch, a tag or a pull-request ref", () => {
		for (const ref of ["refs/heads/ci/6642-forced-suite-matrix", "refs/tags/v2026.11.13", "refs/pull/6645/merge"]) {
			assert.throws(() => assertLiveRunOnMain({ dryRun: false, env: actions(ref), what: "the release" }), new RegExp(ref.replaceAll("/", "\\/")));
		}
	});

	it("refuses a live run in GitHub Actions whose GITHUB_REF is missing", () => {
		assert.throws(() => assertLiveRunOnMain({ dryRun: false, env: actions(undefined), what: "npm publish" }), /refs\/heads\/main/);
	});

	it("allows a live run on refs/heads/main, any dry run, and any run outside GitHub Actions", () => {
		assert.doesNotThrow(() => assertLiveRunOnMain({ dryRun: false, env: actions("refs/heads/main"), what: "the release" }));
		assert.doesNotThrow(() => assertLiveRunOnMain({ dryRun: true, env: actions("refs/heads/feature"), what: "the release" }));
		assert.doesNotThrow(() => assertLiveRunOnMain({ dryRun: false, env: { GITHUB_REF: "refs/heads/feature" }, what: "the release" }));
	});
});
