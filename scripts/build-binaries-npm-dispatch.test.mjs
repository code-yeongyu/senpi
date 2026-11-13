#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";

const { jobs } = parse(readFileSync(new URL("../.github/workflows/build-binaries.yml", import.meta.url), "utf8"));
const codingAgentPackage = JSON.parse(readFileSync(new URL("../packages/coding-agent/package.json", import.meta.url), "utf8"));

function needsOf(name) {
	const needs = jobs[name]?.needs ?? [];
	return Array.isArray(needs) ? needs : [needs];
}

// Every job the named job waits for, directly or through another job.
function upstream(name) {
	const seen = new Set();
	const visit = (job) => {
		for (const need of needsOf(job)) {
			if (!seen.has(need)) {
				seen.add(need);
				visit(need);
			}
		}
	};
	visit(name);
	return seen;
}

describe("build-binaries.yml npm dispatch and binary smoke (senpi#6627)", () => {
	it("dispatches the npm publish without waiting for the standalone-binary smoke", () => {
		const waitsFor = upstream("publish-npm");
		assert.ok(waitsFor.has("build"), "publish-npm must still wait for the build job");
		assert.ok(!waitsFor.has("smoke-test-binaries"), "publish-npm waits for the binary smoke, which needs a macOS runner");
		assert.ok(!waitsFor.has("stage-github-release"), "publish-npm waits for the GitHub Release staging, which waits for the binary smoke");
	});

	it("keeps the GitHub Release, which ships the smoked binaries, gated on the full smoke matrix", () => {
		assert.deepEqual([...jobs["smoke-test-binaries"].strategy.matrix.runner].sort(), ["macos-latest", "ubuntu-latest", "windows-latest"]);
		for (const job of ["stage-github-release", "publish-github-release"]) {
			assert.ok(upstream(job).has("smoke-test-binaries"), `${job} no longer waits for the binary smoke`);
		}
		assert.ok(upstream("publish-github-release").has("publish-npm"), "the GitHub Release must still wait for npm");
	});

	it("smokes binaries that the npm packages do not ship", () => {
		// The smoke extracts the standalone archives built into packages/coding-agent/binaries/; the
		// coding-agent tarball's files list never includes that directory.
		assert.ok(!codingAgentPackage.files.some((entry) => entry.replace(/^\.?\//, "").startsWith("binaries")));
	});

	it("still cleans up a staged draft whenever staging, npm or the release publish fails", () => {
		const cleanup = jobs["cleanup-draft-github-release"];
		for (const need of ["build", "stage-github-release", "publish-npm", "publish-github-release"]) {
			assert.ok(needsOf("cleanup-draft-github-release").includes(need), `cleanup no longer needs ${need}`);
		}
		assert.match(cleanup.if, /needs\.stage-github-release\.result != 'skipped'/);
		assert.match(cleanup.if, /needs\.publish-npm\.result != 'success'/);
	});
});
