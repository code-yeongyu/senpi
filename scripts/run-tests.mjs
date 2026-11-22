#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { signalGroup } from "./package-manager.mjs";
import { quarantineAgentDirEnv } from "./test-agent-dir.mjs";
import { reportTempLeaks, tempEntries } from "./test-temp-guard.mjs";

const [runner, ...args] = process.argv.slice(2);
if (!runner) throw new Error("usage: run-tests.mjs <vitest|executable> [arguments...]");
const entry =
	runner === "vitest"
		? join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs")
		: undefined;
const parent = tmpdir();
const before = process.env.SENPI_TEST_TEMP_GUARD === "1" ? tempEntries(parent) : undefined;
// Vitest constructs its core _tmpDir before globalSetup. cacheDir/server.deps do not
// control forks' makeTmpCopies, so the environment must be scoped before loading Vitest.
// Keep a run's fallback TUI socket inside its root, even under a long inherited
// macOS/agent TMPDIR. This models the 103-byte contract in socket-ownership.ts.
const socketPath = join(parent, "st-XXXXXX", "senpi-rpc-00000000", "tui", "t-0000000000000000.sock");
const rootParent = process.platform !== "win32" && Buffer.byteLength(socketPath) > 103 ? "/tmp" : parent;
const root = mkdtempSync(join(rootParent, "st-"));
if (before) console.log(`[test-temp] owned root: ${JSON.stringify(basename(root))}`);
let child;
let forwarded;
const pendingSignals = [];
const handlers = new Map(
	["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => [
		signal,
		() => {
			forwarded = signal;
			if (child) pendingSignals.push(signalGroup(child, signal));
		},
	]),
);
for (const [signal, handler] of handlers) process.on(signal, handler);
try {
	// The job can retire this exact owned root again if late child activity recreates it.
	if (process.env.SENPI_TEST_TEMP_REGISTRY) {
		appendFileSync(process.env.SENPI_TEST_TEMP_REGISTRY, `${JSON.stringify(root)}\n`);
	}
	child = spawn(entry ? process.execPath : runner, entry ? [entry, ...args] : args, {
		stdio: "inherit",
		detached: process.platform !== "win32",
		env: {
			...quarantineAgentDirEnv(process.env, root),
			TMPDIR: root,
			TEMP: root,
			TMP: root,
			JITI_RESPECT_TMPDIR_ENV: "1",
		},
	});
	process.exitCode = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code ?? 1));
	});
} finally {
	await Promise.all(pendingSignals);
	// Runs on success, test failure, spawn error, worker SIGKILL and catchable interrupts.
	// SIGKILL of this owner itself cannot execute teardown; never reap another run's root.
	try {
		rmSync(root, { recursive: true, force: true, maxRetries: 3 });
	} catch (error) {
		console.error(
			`[test-temp] child exited with ${process.exitCode}; cleanup failed for ${root}: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exitCode = 1;
	} finally {
		for (const [signal, handler] of handlers) process.off(signal, handler);
	}
}
if (before) {
	const survivingRoot = existsSync(root) ? 1 : 0;
	console.log(`[test-temp] surviving owned run roots after teardown: ${survivingRoot}`);
	if (rootParent !== parent && survivingRoot) console.error(`[test-temp] leftover owned root: ${JSON.stringify(root)}`);
	if (reportTempLeaks(parent, before) !== 0 || survivingRoot !== 0) process.exitCode = 1;
}
if (forwarded) process.kill(process.pid, forwarded);
