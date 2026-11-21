#!/usr/bin/env node
// senpi#6642: the forced-suite prepare job resolves the base commit once and fixes the version; every later job and
// release.mjs use its outputs and never resolve main again. Since senpi#2287 it regenerates nothing: the matrix jobs test
// and the release tags the dispatched commit itself. Release contract.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const PREPARE_CLI = fileURLToPath(new URL("./release-forced-prepare.mjs", import.meta.url));

function withRepo(run) {
	const root = mkdtempSync(join(tmpdir(), "forced-prepare-"));
	const dir = join(root, "repo");
	mkdirSync(dir);
	const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
	const commit = (message) => {
		writeFileSync(join(dir, "README.md"), `${message}\n`);
		git(dir, "add", "-A");
		git(dir, "commit", "-q", "-m", message);
		return git(dir, "rev-parse", "HEAD");
	};
	try {
		git(dir, "init", "-q", "-b", "main");
		git(dir, "config", "user.name", "t");
		git(dir, "config", "user.email", "t@example.com");
		git(dir, "config", "commit.gpgsign", "false");
		const base = commit("base");
		return run({ root, dir, base, git, commit });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function runPrepare({ root, dir, args }) {
	const bin = join(root, "bin");
	mkdirSync(bin, { recursive: true });
	// Any npm call (an install, a build, a catalog regeneration) is recorded: prepare must make none.
	const npmCalls = join(root, "npm-calls");
	writeFileSync(join(bin, "npm"), `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(npmCalls)}, process.argv.slice(2).join(" ") + "\\n");\n`);
	chmodSync(join(bin, "npm"), 0o755);
	const output = join(root, "github-output");
	writeFileSync(output, "");
	const result = spawnSync(process.execPath, [PREPARE_CLI, "--version", "2026.11.13", "--github-output", output, ...args], {
		cwd: dir,
		env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` },
		encoding: "utf8",
		timeout: 30_000,
	});
	const outputs = Object.fromEntries(
		readFileSync(output, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => line.split("=")),
	);
	let npm = "";
	try {
		npm = readFileSync(npmCalls, "utf8");
	} catch {}
	return { result, outputs, npm };
}

describe("release-forced-prepare CLI resolves the base once", () => {
	it("without --sha, outputs the checked-out commit as the full base and the fixed version, running no npm", () =>
		withRepo(({ root, dir, base }) => {
			const { result, outputs, npm } = runPrepare({ root, dir, args: [] });
			assert.equal(result.status, 0, result.stderr + result.stdout);
			assert.deepEqual(outputs, { base_sha: base, version: "2026.11.13" });
			assert.equal(result.stdout.match(/base commit for every later job: ([0-9a-f]+)/g)?.length, 1, result.stdout);
			assert.equal(npm, "", "prepare installed, built or regenerated something");
		}));

	it("with --sha, outputs that pinned main commit as the base, not the checkout it started from", () =>
		withRepo(({ root, dir, git, commit }) => {
			const origin = join(root, "origin.git");
			git(root, "init", "-q", "--bare", "-b", "main", origin);
			const pinned = commit("pinned");
			commit("main moved");
			git(dir, "remote", "add", "origin", origin);
			git(dir, "push", "-q", "origin", "main");
			const { result, outputs } = runPrepare({ root, dir, args: ["--sha", pinned] });
			assert.equal(result.status, 0, result.stderr + result.stdout);
			assert.equal(outputs.base_sha, pinned);
			assert.match(result.stdout, new RegExp(`base commit for every later job: ${pinned}\\n`));
		}));

	it("refuses a --sha origin/main does not reach, before writing any output", () =>
		withRepo(({ root, dir, git, commit }) => {
			const origin = join(root, "origin.git");
			git(root, "init", "-q", "--bare", "-b", "main", origin);
			git(dir, "remote", "add", "origin", origin);
			git(dir, "push", "-q", "origin", "main");
			const branchOnly = commit("not on main");
			const { result, outputs } = runPrepare({ root, dir, args: ["--sha", branchOnly] });
			assert.notEqual(result.status, 0);
			assert.match(result.stderr, /is not on main/);
			assert.deepEqual(outputs, {});
		}));
});
