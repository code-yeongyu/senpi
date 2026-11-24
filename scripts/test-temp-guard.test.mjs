#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const guard = fileURLToPath(new URL("./test-temp-guard.mjs", import.meta.url));
const runner = fileURLToPath(new URL("./run-tests.mjs", import.meta.url));

function isolateSystemChecks(receipt, parent) {
	const snapshot = JSON.parse(readFileSync(receipt, "utf8"));
	// Nested guards run beside other script tests. Their system scanner is exercised
	// separately; do not attribute a sibling test's still-live scope to this fixture.
	snapshot.system = snapshot.system.filter((system) => system.directory === parent);
	writeFileSync(receipt, JSON.stringify(snapshot));
}

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
		isolateSystemChecks(receipt, directory);
		assert.equal(readFileSync(environmentFile, "utf8"), `TMPDIR=${scope}\nTEMP=${scope}\nTMP=${scope}\nSENPI_TEST_TEMP_REGISTRY=${registry}\n`);
		writeFileSync(join(scope, "node-compile-cache", "npm-cache"), "job-owned cache");
		mkdirSync(join(scope, "jiti"), { recursive: true }); // jiti creates its default cache dir on first load
		writeFileSync(join(scope, "jiti", "extension.cjs"), "job-owned cache");
		const ran = spawnSync(process.execPath, [runner, process.execPath, "-e", ""], {
			...options, env: { ...options.env, TMPDIR: scope, TEMP: scope, TMP: scope, SENPI_TEST_TEMP_REGISTRY: registry },
		});
		assert.ifError(ran.error);
		assert.equal(ran.status, 0, ran.stderr);
		const root = JSON.parse(readFileSync(registry, "utf8").trim());
		mkdirSync(root);
		writeFileSync(join(root, "late-worker-write"), "owned");
		const checked = spawnSync(process.execPath, [guard, "check", receipt], options);
		assert.ifError(checked.error);
		assert.equal(checked.status, 1);
		assert.match(checked.stdout, /recorded owned roots retired at job teardown: 1/);
		assert.match(checked.stderr, /late-worker-write/);
		assert.doesNotMatch(checked.stderr, /leftover: "jiti"/);
		assert.equal(existsSync(scope), false, "the exclusive job parent is removed even on leak failure");
		assert.equal(readFileSync(environmentFile, "utf8"),
			`TMPDIR=${scope}\nTEMP=${scope}\nTMP=${scope}\nSENPI_TEST_TEMP_REGISTRY=${registry}\n` +
			Object.entries(environment).map(([name, value]) => `${name}=${value}\n`).join(""));
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});

test("a surviving child fails the guard; an awaited child leaves a clean run (#3064)", { timeout: 20_000 }, async () => {
	const parent = mkdtempSync(join(tmpdir(), "senpi-survivor-proof-"));
	const receipt = join(parent, "snapshot.json");
	const env = { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent, GITHUB_ENV: join(parent, "github.env") };
	const options = { env, encoding: "utf8", timeout: 10_000 };
	let child;
	let closed;
	try {
		assert.equal(spawnSync(process.execPath, [guard, "snapshot", receipt, "--export-env"], options).status, 0);
		const { registry, scope } = JSON.parse(readFileSync(receipt, "utf8"));
		isolateSystemChecks(receipt, parent);
		const root = join(scope, "st-surviving-child");
		writeFileSync(registry, `${JSON.stringify(root)}\n`);
		child = spawn(process.execPath, ["-e", `
			const fs = require("node:fs");
			fs.mkdirSync(${JSON.stringify(root)});
			fs.writeFileSync(${JSON.stringify(join(root, "child-still-alive"))}, "leak");
			process.send("created");
			process.on("message", () => process.exit(0));
		`], { stdio: ["ignore", "ignore", "ignore", "ipc"], env });
		closed = once(child, "close");
		await once(child, "message", { signal: AbortSignal.timeout(5_000) });
		const leaked = spawnSync(process.execPath, [guard, "check", receipt], options);
		assert.equal(leaked.status, 1, leaked.stdout);
		assert.match(leaked.stderr, /child-still-alive/);
		child.send("stop");
		await closed;
		assert.equal(spawnSync(process.execPath, [guard, "snapshot", receipt, "--export-env"], options).status, 0);
		isolateSystemChecks(receipt, parent);
		const clean = spawnSync(process.execPath, [guard, "check", receipt], options);
		assert.equal(clean.status, 0, clean.stderr);
		assert.match(clean.stdout, /after teardown: 0/);
	} finally {
		if (child?.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		if (closed) await closed;
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

test("the system baseline also protects a recorded root outside the job scope (#3064)", () => {
	const parent = mkdtempSync(join(tmpdir(), "senpi-system-baseline-proof-"));
	try {
		const baseline = join(parent, "st-baseline");
		mkdirSync(baseline);
		const receipt = join(parent, "snapshot.json");
		const options = { env: { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent,
			GITHUB_ENV: join(parent, "github.env") }, encoding: "utf8", timeout: 10_000 };
		assert.equal(spawnSync(process.execPath, [guard, "snapshot", receipt, "--export-env"], options).status, 0);
		isolateSystemChecks(receipt, parent);
		const { registry } = JSON.parse(readFileSync(receipt, "utf8"));
		writeFileSync(registry, `${JSON.stringify(baseline)}\n`);
		const checked = spawnSync(process.execPath, [guard, "check", receipt], options);
		assert.equal(checked.status, 1);
		assert.equal(existsSync(baseline), true);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});
