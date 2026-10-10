#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, opendirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { signalGroup } from "./package-manager.mjs";

const [runner, ...args] = process.argv.slice(2);
if (!runner) throw new Error("usage: run-tests.mjs <vitest|executable> [arguments...]");
const entry = runner === "vitest"
	? join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs")
	: undefined;
const parent = tmpdir();
// Only enumerate top-level names, with an explicit cap: never walk a shared temp tree.
function entries() {
	const directory = opendirSync(parent);
	const names = [];
	try {
		for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
			if (names.length === 100_000) throw new Error("temp guard exceeded 100000 top-level entries");
			names.push(entry.name);
		}
	} finally {
		directory.closeSync();
	}
	return names.sort();
}
const before = process.env.SENPI_TEST_TEMP_GUARD === "1" ? new Set(entries()) : undefined;
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
	const leaked = entries().filter((name) => !before.has(name));
	console.log(`[test-temp] new top-level entries after teardown: ${leaked.length}`);
	if (leaked.length) {
		for (const name of leaked) console.error(`[test-temp] leftover: ${JSON.stringify(name)}`);
		process.exitCode = 1;
	}
}
if (forwarded) process.kill(process.pid, forwarded);
