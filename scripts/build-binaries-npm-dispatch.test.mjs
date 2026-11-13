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

// A job's direct `needs:`: an inline list, a scalar or a block list, each line with an optional trailing comment.
// Any other shape fails, never reads as fewer needs, or upstream() would silently drop that branch.
function needsOf(name) {
	const lines = jobText(name).split("\n");
	const at = lines.findIndex((line) => /^ {4}needs:/.test(line));
	if (at < 0) return [];
	const uncomment = (line) => line.replace(/\s+#.*$/, "").trimEnd();
	const value = uncomment(lines[at]).replace(/^ {4}needs:\s*/, "");
	const fail = (detail) => assert.fail(`job ${name} has a needs: form this test cannot parse: ${detail}`);
	if (value.startsWith("[")) {
		const inline = /^\[([\w\s,-]*)\]$/.exec(value);
		if (!inline) fail(value);
		return inline[1].split(",").map((need) => need.trim()).filter(Boolean);
	}
	if (value) {
		if (!/^[\w-]+$/.test(value)) fail(value);
		return [value];
	}
	const needs = [];
	for (const line of lines.slice(at + 1)) {
		if (line.trim() === "" || /^\s*#/.test(line)) continue;
		if (!/^ {6}/.test(line)) break;
		const entry = /^ {6}- ([\w-]+)$/.exec(uncomment(line));
		if (!entry) fail(line.trim());
		needs.push(entry[1]);
	}
	if (needs.length === 0) fail("an empty block");
	return needs;
}

function jobNames() {
	return [...workflow.matchAll(/^ {2}([\w-]+):\s*$/gm)].map((match) => match[1]);
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

	it("parses the needs: of every job in the workflow", () => {
		const names = jobNames();
		assert.ok(names.includes("publish-npm") && names.includes("smoke-test-binaries"), names.join(", "));
		for (const name of names) {
			for (const need of needsOf(name)) assert.ok(names.includes(need), `${name} needs unknown job ${need}`);
		}
	});

	it("smokes binaries that the npm packages do not ship", () => {
		// The smoke extracts the standalone archives built into packages/coding-agent/binaries/; the
		// coding-agent tarball's files list never includes that directory.
		assert.ok(!codingAgentPackage.files.some((entry) => entry.replace(/^\.?\//, "").startsWith("binaries")));
	});
});
