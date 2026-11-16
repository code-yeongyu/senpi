#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const guard = fileURLToPath(new URL("./test-temp-guard.mjs", import.meta.url));
for (const location of ["pre-export temp", "system /tmp"]) {
	test(`the job guard rejects repo entries escaping to ${location} (#3064)`, {
		skip: location === "system /tmp" && process.platform === "win32",
	}, () => {
		const parent = mkdtempSync(join(tmpdir(), "senpi-system-guard-"));
		let escaped;
		try {
			const receipt = join(parent, "snapshot.json");
			const options = { env: { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent,
				GITHUB_ENV: join(parent, "github.env") }, encoding: "utf8", timeout: 10_000 };
			assert.equal(spawnSync(process.execPath, [guard, "snapshot", receipt, "--export-env"], options).status, 0);
			escaped = mkdtempSync(join(location === "system /tmp" ? "/tmp" : parent, "senpi-rpc-proof-"));
			mkdirSync(join(escaped, "tui"));
			const checked = spawnSync(process.execPath, [guard, "check", receipt], options);
			assert.equal(checked.status, 1, checked.stdout);
			assert.match(checked.stderr, /senpi-rpc-proof-/);
		} finally {
			if (escaped) rmSync(escaped, { recursive: true, force: true });
			rmSync(parent, { recursive: true, force: true });
		}
	});
}

for (const scenario of ["preexisting repo name", "new foreign name"]) {
	test(`the system scan preserves a ${scenario} without failing (#3064)`, () => {
		const parent = mkdtempSync(join(tmpdir(), "senpi-system-guard-"));
		try {
			const other = join(parent, scenario === "preexisting repo name" ? "sj-another-job" : "foreign-daemon-cache");
			if (scenario === "preexisting repo name") mkdirSync(other);
			const receipt = join(parent, "snapshot.json");
			const options = { env: { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent,
				GITHUB_ENV: join(parent, "github.env") }, encoding: "utf8", timeout: 10_000 };
			assert.equal(spawnSync(process.execPath, [guard, "snapshot", receipt, "--export-env"], options).status, 0);
			const snapshot = JSON.parse(readFileSync(receipt, "utf8"));
			// These two predicates are tested against a private system-temp fixture, not other live jobs.
			snapshot.system = snapshot.system.filter(({ directory }) => directory === parent);
			writeFileSync(receipt, JSON.stringify(snapshot));
			if (scenario === "new foreign name") mkdirSync(other);
			const checked = spawnSync(process.execPath, [guard, "check", receipt], options);
			assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
			assert.equal(existsSync(other), true);
			if (scenario === "new foreign name") assert.match(checked.stdout, /unrecognized new system entry:.*foreign-daemon-cache/);
			assert.doesNotMatch(checked.stderr, /leftover:.*(?:sj-another-job|foreign-daemon-cache)/);
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});
}

test("a concurrent job's scope is not this job's leftover; this job's own leaks still are (#6862)", () => {
	const parent = mkdtempSync(join(tmpdir(), "senpi-concurrent-jobs-"));
	const receipt = (job) => join(parent, `${job}.json`);
	const options = (job, extra = {}) => ({ env: { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent,
		GITHUB_ENV: join(parent, `${job}.env`), ...extra }, encoding: "utf8", timeout: 10_000 });
	const scopes = [];
	try {
		// Two jobs on one machine: B starts after A's snapshot, so B's exclusive scope is new in A's system temp.
		const top = (job) => options(job, { SENPI_TEST_TEMP_REGISTRY: "" });
		assert.equal(spawnSync(process.execPath, [guard, "snapshot", receipt("a"), "--export-env"], top("a")).status, 0);
		const a = JSON.parse(readFileSync(receipt("a"), "utf8"));
		scopes.push(a.scope);
		assert.equal(spawnSync(process.execPath, [guard, "snapshot", receipt("b"), "--export-env"], top("b")).status, 0);
		const b = JSON.parse(readFileSync(receipt("b"), "utf8"));
		scopes.push(b.scope);
		// Job A's own tests leave a nested guard scope behind (it inherits A's registry) and a file in A's scope.
		const nested = options("nested", { TMPDIR: a.scope, TEMP: a.scope, TMP: a.scope, SENPI_TEST_TEMP_REGISTRY: a.registry });
		assert.equal(spawnSync(process.execPath, [guard, "snapshot", join(parent, "nested.json"), "--export-env"], nested).status, 0);
		const leaked = JSON.parse(readFileSync(join(parent, "nested.json"), "utf8")).scope;
		scopes.push(leaked);
		writeFileSync(join(a.scope, "own-leak"), "leak");
		const unmarked = mkdtempSync(join(parent, "sj-")); // in A's pre-export temp; no owner record
		const checked = spawnSync(process.execPath, [guard, "check", receipt("a")], top("a"));
		assert.equal(checked.status, 1, checked.stdout);
		assert.match(checked.stderr, /leftover: "own-leak"/);
		assert.match(checked.stderr, new RegExp(`leftover: "${basename(leaked)}"`));
		assert.match(checked.stderr, new RegExp(`leftover: "${basename(unmarked)}"`));
		assert.doesNotMatch(checked.stderr, new RegExp(`leftover: "${basename(b.scope)}"`));
		assert.equal(existsSync(b.scope), true, "another job's scope is never removed");
	} finally {
		for (const scope of scopes) rmSync(scope, { recursive: true, force: true });
		rmSync(parent, { recursive: true, force: true });
	}
});
