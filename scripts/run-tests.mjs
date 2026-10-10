#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { signalGroup } from "./package-manager.mjs";
import { reportTempLeaks, tempEntries } from "./test-temp-guard.mjs";

const [runner, ...args] = process.argv.slice(2);
if (!runner) throw new Error("usage: run-tests.mjs <vitest|executable> [arguments...]");
const entry = runner === "vitest"
	? join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs")
	: undefined;
const parent = tmpdir();
const before = process.env.SENPI_TEST_TEMP_GUARD === "1" ? tempEntries(parent) : undefined;
// Vitest constructs its core _tmpDir before globalSetup. cacheDir/server.deps do not
// control forks' makeTmpCopies, so the environment must be scoped before loading Vitest.
const root = mkdtempSync(join(parent, "st-"));
let child;
let forwarded;
const handlers = new Map(
	["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [signal, () => {
		forwarded = signal;
		if (child) signalGroup(child, signal);
	}]),
);
for (const [signal, handler] of handlers) process.on(signal, handler);
try {
	child = spawn(entry ? process.execPath : runner, entry ? [entry, ...args] : args, {
		stdio: "inherit",
		detached: process.platform !== "win32",
		env: { ...process.env, TMPDIR: root, TEMP: root, TMP: root },
	});
	process.exitCode = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code ?? 1));
	});
} finally {
	// Runs on success, test failure, spawn error, worker SIGKILL and catchable interrupts.
	// SIGKILL of this owner itself cannot execute teardown; never reap another run's root.
	rmSync(root, { recursive: true, force: true, maxRetries: 3 });
	for (const [signal, handler] of handlers) process.off(signal, handler);
}
if (before) {
	if (reportTempLeaks(parent, before) !== 0) process.exitCode = 1;
}
if (forwarded) process.kill(process.pid, forwarded);
