#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { appendProbes, copyRepo, knipUnusedExports, realTempDir } from "./knip-probe.test-support.mjs";

// knip export coverage never shrinks (senpi#4421). A file is export-checked when knip, run with a given knip.jsonc,
// reports a new unused export in it. This test appends one unused export to every source file of a temp copy of this
// tree, runs knip once with this tree's knip.jsonc (the one CI runs) and once with the base branch's, and fails naming
// every file the base config export-checked that this config no longer does (an added "exports" ignore, a dropped entry,
// a workspace that lost includeEntryExports, a new `ignore` pattern).
//
// The base is KNIP_COVERAGE_BASE (default origin/main), which must be fetched. When the base has no knip.jsonc yet, the
// comparison uses the first knip.jsonc on the branch (oldest commit in <base>..KNIP_COVERAGE_HISTORY, default HEAD,
// that added it). CI runs this from the Static checks job after fetching both (.github/workflows/ci.yml).

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20 });
const gitOk = (...args) => spawnSync("git", args, { cwd: repo, stdio: "ignore" }).status === 0;

function baseConfig() {
	const base = process.env.KNIP_COVERAGE_BASE ?? "origin/main";
	assert.ok(gitOk("rev-parse", "--verify", "--quiet", `${base}^{commit}`), `base ${base} is not available; fetch it (git fetch origin main) or set KNIP_COVERAGE_BASE`);
	if (gitOk("cat-file", "-e", `${base}:knip.jsonc`)) return { source: `${base}:knip.jsonc`, text: git("show", `${base}:knip.jsonc`) };
	const history = process.env.KNIP_COVERAGE_HISTORY ?? "HEAD";
	const first = git("log", "--reverse", "--diff-filter=A", "--format=%H", `${base}..${history}`, "--", "knip.jsonc").split("\n").find(Boolean);
	assert.ok(first, `${base} has no knip.jsonc and no commit in ${base}..${history} adds one; fetch the branch history or set KNIP_COVERAGE_HISTORY`);
	return { source: `${first.slice(0, 10)}:knip.jsonc (first knip config on the branch; ${base} has none)`, text: git("show", `${first}:knip.jsonc`) };
}

test("knip still export-checks every file the base branch's knip.jsonc export-checked", () => {
	const base = baseConfig();
	const work = realTempDir("knip-export-coverage-");
	try {
		const probes = appendProbes(work, copyRepo(repo, work).filter((file) => SOURCE.test(file)), "zzKnipCoverage_");
		const checked = () => {
			const reported = knipUnusedExports(repo, work);
			return new Set(probes.filter(({ file, name }) => reported.has(`${file}#${name}`)).map(({ file }) => file));
		};
		const atHead = checked();
		writeFileSync(join(work, "knip.jsonc"), base.text);
		const atBase = checked();
		const lost = [...atBase].filter((file) => !atHead.has(file)).sort();
		const gained = [...atHead].filter((file) => !atBase.has(file)).length;
		console.log(`knip-export-coverage: ${probes.length} source files probed; ${base.source} export-checks ${atBase.size}, this tree ${atHead.size}; lost ${lost.length}, gained ${gained}`);
		assert.deepEqual(lost, [], "files the base knip.jsonc export-checks that this knip.jsonc no longer does; drop the new ignore or entry change, or fix the dead export instead");
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
});
