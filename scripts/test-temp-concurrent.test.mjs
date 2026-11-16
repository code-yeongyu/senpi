#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const guard = fileURLToPath(new URL("./test-temp-guard.mjs", import.meta.url));

// Two guarded jobs on one machine (#6862). Each job's checkout (its receipt and registry) exists before either
// snapshot, as on a shared runner; B snapshots after A, so B's exclusive scope is new in A's system temp.
function concurrentJobs() {
	const parent = mkdtempSync(join(tmpdir(), "senpi-concurrent-jobs-"));
	for (const job of ["a", "b"]) mkdirSync(join(parent, job));
	const receipt = (job) => join(parent, job, "receipt.json");
	const env = (job, extra = {}) => ({ ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent,
		GITHUB_ENV: join(parent, job, "github.env"), SENPI_TEST_TEMP_REGISTRY: "", ...extra });
	const run = (args, environment) => spawnSync(process.execPath, args, { env: environment, encoding: "utf8", timeout: 20_000 });
	const scopes = [];
	const snapshot = (file, environment) => {
		const done = run([guard, "snapshot", file, "--export-env"], environment);
		assert.equal(done.status, 0, done.stderr);
		const taken = JSON.parse(readFileSync(file, "utf8"));
		scopes.push(taken.scope);
		return taken;
	};
	const a = snapshot(receipt("a"), env("a"));
	const b = snapshot(receipt("b"), env("b"));
	// A guard run inside job A's own tests: TMPDIR is A's scope, and its receipt sits wherever the test put it.
	const nested = (directory, extra = {}) => snapshot(join(mkdtempSync(join(directory, "senpi-nested-")), "receipt.json"),
		env("a", { TMPDIR: a.scope, TEMP: a.scope, TMP: a.scope, SENPI_TEST_TEMP_REGISTRY: a.registry,
			GITHUB_ENV: join(a.scope, "nested.env"), ...extra }));
	const checkA = (args = []) => run([...args, guard, "check", receipt("a")], env("a"));
	const cleanup = () => {
		for (const scope of scopes) rmSync(scope, { recursive: true, force: true });
		rmSync(parent, { recursive: true, force: true });
	};
	return { parent, a, b, env, run, receipt, nested, checkA, cleanup };
}

const leftover = (name) => new RegExp(`leftover: "${name}"`);

test("a concurrent job's scope is not this job's leftover; this job's own leaks still are (#6862)", () => {
	const jobs = concurrentJobs();
	try {
		const { a, b, parent } = jobs;
		const own = jobs.nested(a.scope);
		writeFileSync(join(a.scope, "own-leak"), "leak");
		const unmarked = mkdtempSync(join(parent, "sj-")); // in A's pre-export temp; no owner record
		const checked = jobs.checkA();
		assert.equal(checked.status, 1, checked.stdout);
		assert.match(checked.stderr, leftover("own-leak"));
		assert.match(checked.stderr, leftover(basename(own.scope)));
		assert.match(checked.stderr, leftover(basename(unmarked)));
		assert.match(checked.stdout, new RegExp(`concurrent job scope, not this job's: .*${basename(b.scope)}`));
		assert.doesNotMatch(checked.stderr, leftover(basename(b.scope)));
		assert.equal(existsSync(b.scope), true, "another job's scope is never removed");
	} finally {
		jobs.cleanup();
	}
});

// The other job's recursive remove may take its owner record before its large cache directories (#6862 review M1).
// The hook makes B's teardown unlink its plain files first, then runs A's real check at exactly that point.
const midTeardown = `
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const { check, env, out } = JSON.parse(process.env.SENPI_TEST_INTERLEAVE);
const rmSync = fs.rmSync;
let fired = false;
fs.rmSync = (path, options) => {
	if (!fired && fs.statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
		fired = true;
		for (const entry of fs.readdirSync(path, { withFileTypes: true }))
			if (entry.isFile()) fs.unlinkSync(join(path, entry.name));
		const seen = spawnSync(process.execPath, check, { env, encoding: "utf8" });
		fs.writeFileSync(out, JSON.stringify({ status: seen.status, stdout: seen.stdout, stderr: seen.stderr }));
	}
	return rmSync(path, options);
};
syncBuiltinESMExports();
`;

test("a concurrent job's scope is not this job's leftover while that job tears it down (#6862)", () => {
	const jobs = concurrentJobs();
	try {
		const { a, b, parent } = jobs;
		const named = (scope) => new RegExp(`leftover: "[^"]*${basename(scope).slice(3)}"`);
		const out = join(parent, "a", "mid-teardown-check.json");
		const interleave = JSON.stringify({ check: [guard, "check", jobs.receipt("a")], env: jobs.env("a"), out });
		const tornDown = jobs.run(["--import", `data:text/javascript,${encodeURIComponent(midTeardown)}`, guard, "check",
			jobs.receipt("b")], jobs.env("b", { SENPI_TEST_INTERLEAVE: interleave }));
		// Both checks also scan the shared /tmp, where a parallel test file or another job may hold repo-named entries,
		// so only the outcome for these two jobs' scopes is asserted, never either check's overall status.
		assert.equal(existsSync(out), true, `B's teardown reached the interleaved check\n${tornDown.stdout}\n${tornDown.stderr}`);
		for (const scope of [a.scope, b.scope]) assert.doesNotMatch(tornDown.stderr, named(scope), tornDown.stdout);
		const seen = JSON.parse(readFileSync(out, "utf8"));
		assert.doesNotMatch(seen.stderr, named(b.scope), seen.stdout);
		assert.equal(existsSync(b.scope), false);
	} finally {
		jobs.cleanup();
	}
});

// A scope this job's own tests leaked must stay this job's leftover whatever its owner record says (#6862 review L1).
const ownScopes = {
	"a record with no owner registry (the test cleared SENPI_TEST_TEMP_REGISTRY)": (jobs) =>
		jobs.nested(jobs.parent, { SENPI_TEST_TEMP_REGISTRY: "" }).scope,
	"a grandchild whose intermediate guard was deleted without a check": (jobs) => {
		const child = jobs.nested(jobs.a.scope);
		const grandchild = jobs.nested(child.scope, { TMPDIR: child.scope, TEMP: child.scope, TMP: child.scope,
			SENPI_TEST_TEMP_REGISTRY: child.registry });
		rmSync(child.scope, { recursive: true, force: true });
		return grandchild.scope;
	},
	"a forged empty owner record": (jobs) => {
		const forged = mkdtempSync(join(jobs.parent, "sj-"));
		writeFileSync(join(forged, ".senpi-test-temp-scope.json"), "{}");
		return forged;
	},
};
for (const [scenario, leak] of Object.entries(ownScopes)) {
	test(`this job's leaked scope is still reported: ${scenario} (#6862)`, {
		skip: scenario.startsWith("a grandchild") && process.platform === "win32"
			? "win32 nests scopes inside the parent scope, so deleting the child also deletes the grandchild" : false,
	}, () => {
		const jobs = concurrentJobs();
		try {
			const leaked = leak(jobs);
			const checked = jobs.checkA();
			assert.equal(checked.status, 1, checked.stdout);
			assert.match(checked.stderr, leftover(basename(leaked)), checked.stdout);
			assert.doesNotMatch(checked.stderr, leftover(basename(jobs.b.scope)));
		} finally {
			jobs.cleanup();
		}
	});
}
