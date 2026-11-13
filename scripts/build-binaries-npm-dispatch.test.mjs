#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/build-binaries.yml", import.meta.url), "utf8");
const codingAgentPackage = JSON.parse(readFileSync(new URL("../packages/coding-agent/package.json", import.meta.url), "utf8"));

// The text of one top-level job: from its `  name:` line to the next job or the end of the file.
function jobText(name) {
	const lines = workflow.split("\n");
	const start = lines.indexOf(`  ${name}:`);
	assert.ok(start >= 0, `no job ${name} in build-binaries.yml`);
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => /^ {2}[\w-]+:\s*$/.test(line) || /^\S/.test(line));
	return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

// A job's direct `needs:`, in any of the three YAML shapes the workflow uses.
function needsOf(name) {
	const text = jobText(name);
	const inline = /^ {4}needs:\s*\[([^\]]*)\]/m.exec(text);
	if (inline) return inline[1].split(",").map((need) => need.trim()).filter(Boolean);
	const scalar = /^ {4}needs:\s*([\w-]+)\s*$/m.exec(text);
	if (scalar) return [scalar[1]];
	const block = /^ {4}needs:\s*\n((?: {6}- [\w-]+\n?)+)/m.exec(text);
	return block ? block[1].trim().split("\n").map((line) => line.replace(/^\s*-\s*/, "").trim()) : [];
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
		const runners = /^ {8}runner:\s*\n((?: {10}- \S+\n?)+)/m.exec(jobText("smoke-test-binaries"));
		assert.ok(runners, "the smoke matrix lists no runners");
		assert.deepEqual(
			runners[1].trim().split("\n").map((line) => line.replace(/^\s*-\s*/, "").trim()).sort(),
			["macos-latest", "ubuntu-latest", "windows-latest"],
		);
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
});
