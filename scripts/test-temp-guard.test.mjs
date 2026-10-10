#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const guard = fileURLToPath(new URL("./test-temp-guard.mjs", import.meta.url));
const runner = fileURLToPath(new URL("./run-tests.mjs", import.meta.url));

test("job-final guard detects new entries without deleting baseline or leaked files (#3064)", () => {
	const parent = mkdtempSync(join(tmpdir(), "senpi-job-guard-proof-"));
	try {
		const directory = join(parent, "scan");
		mkdirSync(directory);
		writeFileSync(join(directory, "baseline"), "keep");
		const receipt = join(parent, "snapshot.json");
		const options = { env: { ...process.env, TMPDIR: directory, TEMP: directory, TMP: directory }, encoding: "utf8", timeout: 10_000 };
		const snapshot = spawnSync(process.execPath, [guard, "snapshot", receipt], options);
		assert.ifError(snapshot.error);
		assert.equal(snapshot.status, 0, snapshot.stderr);
		const clean = spawnSync(process.execPath, [guard, "check", receipt], options);
		assert.ifError(clean.error);
		assert.equal(clean.status, 0, clean.stderr);
		assert.match(clean.stdout, /after teardown: 0/);
		mkdirSync(join(directory, "new-entry"));
		const leaked = spawnSync(process.execPath, [guard, "check", receipt], options);
		assert.ifError(leaked.error);
		assert.equal(leaked.status, 1);
		assert.match(leaked.stdout, /after teardown: 1/);
		assert.match(leaked.stderr, /leftover: "new-entry"/);
		assert.deepEqual(readdirSync(directory).sort(), ["baseline", "new-entry"]);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});

test("job teardown retires only recorded run roots, including a late recreated root (#3064)", () => {
	const parent = mkdtempSync(join(tmpdir(), "senpi-job-owner-proof-"));
	try {
		const directory = join(parent, "scan");
		mkdirSync(directory);
		const receipt = join(parent, "snapshot.json");
		const environmentFile = join(parent, "github.env");
		const options = {
			env: { ...process.env, TMPDIR: directory, TEMP: directory, TMP: directory, GITHUB_ENV: environmentFile },
			encoding: "utf8", timeout: 10_000,
		};
		const snapshot = spawnSync(process.execPath, [guard, "snapshot", receipt], options);
		assert.ifError(snapshot.error);
		assert.equal(snapshot.status, 0, snapshot.stderr);
		assert.equal(existsSync(environmentFile), false, "nested snapshots must not change the CI environment");
		const exported = spawnSync(process.execPath, [guard, "snapshot", receipt, "--export-env"], options);
		assert.ifError(exported.error);
		assert.equal(exported.status, 0, exported.stderr);
		const { registry, scope, environment } = JSON.parse(readFileSync(receipt, "utf8"));
		assert.equal(readFileSync(environmentFile, "utf8"), `TMPDIR=${scope}\nTEMP=${scope}\nTMP=${scope}\nSENPI_TEST_TEMP_REGISTRY=${registry}\n`);
		const ran = spawnSync(process.execPath, [runner, process.execPath, "-e", ""], {
			...options, env: { ...options.env, TMPDIR: scope, TEMP: scope, TMP: scope, SENPI_TEST_TEMP_REGISTRY: registry },
		});
		assert.ifError(ran.error);
		assert.equal(ran.status, 0, ran.stderr);
		const root = JSON.parse(readFileSync(registry, "utf8").trim());
		mkdirSync(root);
		writeFileSync(join(root, "late-worker-write"), "owned");
		const unowned = join(scope, "st-unowned");
		mkdirSync(unowned);
		const checked = spawnSync(process.execPath, [guard, "check", receipt], options);
		assert.ifError(checked.error);
		assert.equal(checked.status, 1);
		assert.match(checked.stdout, /recorded owned roots retired at job teardown: 1/);
		assert.match(checked.stderr, /leftover: "st-unowned"/);
		assert.equal(existsSync(scope), false, "the exclusive job parent is removed even on leak failure");
		assert.equal(readFileSync(environmentFile, "utf8"),
			`TMPDIR=${scope}\nTEMP=${scope}\nTMP=${scope}\nSENPI_TEST_TEMP_REGISTRY=${registry}\n` +
			Object.entries(environment).map(([name, value]) => `${name}=${value}\n`).join(""));
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});

test("a journal cannot authorize removal of a pre-existing temp entry (#3064)", () => {
	const parent = mkdtempSync(join(tmpdir(), "senpi-job-baseline-proof-"));
	try {
		const directory = join(parent, "scan");
		mkdirSync(directory);
		const baseline = join(directory, "st-baseline");
		mkdirSync(baseline);
		const receipt = join(parent, "snapshot.json");
		const options = { env: { ...process.env, TMPDIR: directory, TEMP: directory, TMP: directory }, encoding: "utf8", timeout: 10_000 };
		const snapshot = spawnSync(process.execPath, [guard, "snapshot", receipt], options);
		assert.ifError(snapshot.error);
		assert.equal(snapshot.status, 0, snapshot.stderr);
		const { registry } = JSON.parse(readFileSync(receipt, "utf8"));
		writeFileSync(registry, `${JSON.stringify(baseline)}\n`);
		const checked = spawnSync(process.execPath, [guard, "check", receipt], options);
		assert.ifError(checked.error);
		assert.equal(checked.status, 1);
		assert.deepEqual(readdirSync(directory), ["st-baseline"]);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});
