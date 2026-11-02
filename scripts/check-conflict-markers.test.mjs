#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const checker = join(root, "scripts", "check-conflict-markers.mjs");

function repoWith(t, files) {
	const repo = mkdtempSync(join(tmpdir(), "check-conflict-markers-"));
	t.after(() => rmSync(repo, { recursive: true, force: true }));
	execFileSync("git", ["init", "-q"], { cwd: repo });
	for (const [name, content] of Object.entries(files)) writeFileSync(join(repo, name), content);
	execFileSync("git", ["add", "."], { cwd: repo });
	return repo;
}

function check(repo) {
	return spawnSync("node", [checker], { cwd: repo, timeout: 10000, encoding: "utf8" });
}

describe("check-conflict-markers", () => {
	it("fails with path:line for an orphaned diff3 base marker in a tracked file", (t) => {
		// Given
		const repo = repoWith(t, {
			"changes.md": "## Entry one\n\n||||||| parent of 1f032c2b4f (perf: something)\n\n## Entry two\n",
		});

		// When
		const result = check(repo);

		// Then
		assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
		assert.match(result.stderr, /changes\.md:3: \|\|\|\|\|\|\| parent of 1f032c2b4f/);
	});

	it("fails for the open and close markers of a full conflict", (t) => {
		// Given
		const repo = repoWith(t, { "a.ts": "<<<<<<< HEAD\nconst a = 1;\n=======\nconst a = 2;\n>>>>>>> topic\n" });

		// When
		const result = check(repo);

		// Then
		assert.equal(result.status, 1);
		assert.match(result.stderr, /a\.ts:1: <<<<<<< HEAD/);
		assert.match(result.stderr, /a\.ts:5: >>>>>>> topic/);
	});

	it("passes Markdown setext underlines, binary files, and untracked files", (t) => {
		// Given
		const repo = repoWith(t, {
			"README.md": "Title\n=======\n\nText with <<<<<<< in the middle of a line.\n",
			"blob.bin": Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from("\n<<<<<<< HEAD\n")]),
		});
		writeFileSync(join(repo, "scratch.md"), "<<<<<<< HEAD\n");

		// When
		const result = check(repo);

		// Then
		assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
		assert.match(result.stdout, /none in 2 tracked files/);
	});
});
