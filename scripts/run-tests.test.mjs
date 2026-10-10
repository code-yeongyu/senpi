#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveWorkspaceDirectories } from "./run-workspaces.mjs";

const runner = fileURLToPath(new URL("./run-tests.mjs", import.meta.url));
const require = createRequire(import.meta.url);
const vitestRoot = dirname(require.resolve("vitest/package.json"));

test("workspace test entrypoints cannot bypass temp ownership (#3064)", async () => {
	const root = fileURLToPath(new URL("../", import.meta.url));
	const workspaces = await resolveWorkspaceDirectories(root);
	const testers = workspaces.filter((workspace) => typeof workspace.scripts.test === "string");
	assert.ok(testers.length > 0);
	for (const workspace of testers) {
		assert.match(workspace.scripts.test, /\brun-tests\.mjs\b/, workspace.relativePath);
	}
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	assert.match(manifest.scripts["test:scripts"], /\brun-tests\.mjs\b/);
});
for (const status of [0, 7]) {
	test(`test runner removes owned temp files after exit ${status} (#3064)`, async () => {
		const parent = mkdtempSync(join(tmpdir(), "senpi-runner-proof-"));
		try {
			const fixture = join(parent, "child.mjs");
			writeFileSync(fixture, `
				import { mkdtempSync, writeFileSync } from "node:fs";
				import { tmpdir } from "node:os";
				import { join } from "node:path";
				const dir = mkdtempSync(join(tmpdir(), "senpi-leak-"));
				writeFileSync(join(dir, "transform"), "SSR copy");
				process.exitCode = ${status};
			`);
			const child = spawn(process.execPath, [runner, process.execPath, fixture], {
				env: { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent },
				stdio: "pipe",
			});
			let output = "";
			child.stderr.on("data", (data) => { output += data; });
			const code = await new Promise((resolve, reject) => {
				child.once("error", reject);
				child.once("close", resolve);
			});
			assert.equal(code, status, output);
			assert.deepEqual(readdirSync(parent), ["child.mjs"], "the child run must leave no new temp entries");
		} finally {
			rmSync(parent, { recursive: true, force: true });
		}
	});
}

test("CI guard fails and names an escaped temp entry (#3064)", async () => {
	const parent = mkdtempSync(join(tmpdir(), "senpi-guard-proof-"));
	try {
		const fixture = join(parent, "escape.mjs");
		writeFileSync(fixture, `
			import { mkdirSync } from "node:fs";
			import { join } from "node:path";
			mkdirSync(join(process.env.ESCAPE_TEMP, "escaped-entry"));
		`);
		const child = spawn(process.execPath, [runner, process.execPath, fixture], {
			env: { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent, ESCAPE_TEMP: parent, SENPI_TEST_TEMP_GUARD: "1" },
			stdio: "pipe",
		});
		let output = "";
		child.stdout.on("data", (data) => { output += data; });
		child.stderr.on("data", (data) => { output += data; });
		const code = await new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		assert.equal(code, 1);
		assert.match(output, /new top-level entries after teardown: 1/);
		assert.match(output, /leftover: "escaped-entry"/);
		assert.deepEqual(readdirSync(parent).sort(), ["escape.mjs", "escaped-entry"]);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});

for (const signal of ["SIGINT", "SIGKILL"]) {
	test(`owned scratch is removed after ${signal} (${signal === "SIGINT" ? "runner" : "worker"}) (#3064)`, {
		skip: process.platform === "win32",
		timeout: 10_000,
	}, async () => {
		const parent = mkdtempSync(join(tmpdir(), "senpi-interrupt-proof-"));
		const fixture = join(parent, "interrupt.mjs");
		writeFileSync(fixture, `
			import { mkdtempSync } from "node:fs";
			import { tmpdir } from "node:os";
			import { join } from "node:path";
			mkdtempSync(join(tmpdir(), "senpi-worker-"));
			console.log("READY " + process.pid);
			setInterval(() => {}, 1000);
		`);
		const child = spawn(process.execPath, [runner, process.execPath, fixture], {
			env: { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent },
			stdio: "pipe",
		});
		let worker;
		const closed = new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		const ready = new Promise((resolve, reject) => {
			let output = "";
			child.once("error", reject);
			child.stdout.on("data", (data) => {
				output += data;
				const match = output.match(/READY (\d+)\n/);
				if (match) {
					worker = Number(match[1]);
					resolve();
				}
			});
			const deadline = setTimeout(() => reject(new Error("worker readiness timed out")), 5000);
			deadline.unref();
			child.once("close", () => clearTimeout(deadline));
			child.stdout.on("data", () => {
				if (worker) clearTimeout(deadline);
			});
			child.once("close", () => reject(new Error("worker exited before readiness")));
		});
		try {
			await ready;
			if (signal === "SIGKILL") process.kill(worker, signal);
			else child.kill(signal);
			await closed;
			assert.deepEqual(readdirSync(parent), ["interrupt.mjs"]);
		} finally {
			child.kill("SIGKILL");
			if (worker) {
				try { process.kill(worker, "SIGKILL"); } catch {}
			}
			rmSync(parent, { recursive: true, force: true });
		}
	});
}

test("helper teardown removes fixtures even after a failing assertion (#3064)", { timeout: 30_000 }, async () => {
	const parent = mkdtempSync(join(tmpdir(), "senpi-helper-proof-"));
	try {
		const receipt = join(parent, "receipt.json");
		const vitest = pathToFileURL(join(vitestRoot, "dist/index.js")).href;
		const helper = new URL("../packages/coding-agent/test/support/temp-agent-dir.ts", import.meta.url).href;
		writeFileSync(join(parent, "proof.test.mjs"), `
			import { it } from ${JSON.stringify(vitest)};
			import { writeFileSync } from "node:fs";
			import { createTempAgentDir } from ${JSON.stringify(helper)};
			const dir = createTempAgentDir();
			writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(dir));
			it("intentional assertion failure", () => { throw new Error("intentional assertion failure"); });
		`);
		// Deliberately bypass the outer cleanup here: otherwise it could hide a broken helper.
		const child = spawn(process.execPath, [join(vitestRoot, "vitest.mjs"), "run", "proof.test.mjs", "--maxWorkers=1"], {
			cwd: parent,
			env: { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent },
			stdio: "pipe",
		});
		let output = "";
		child.stdout.on("data", (data) => { output += data; });
		child.stderr.on("data", (data) => { output += data; });
		const code = await new Promise((resolve, reject) => {
			child.once("error", reject);
			child.once("close", resolve);
		});
		assert.equal(code, 1, output);
		assert.match(output, /intentional assertion failure/);
		assert.equal(existsSync(JSON.parse(readFileSync(receipt, "utf8"))), false, output);
	} finally {
		rmSync(parent, { recursive: true, force: true });
	}
});
