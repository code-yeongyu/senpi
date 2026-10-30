#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { detectPackageManager, packageManagerInvocation, runScriptArguments } from "./package-manager.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const vitest = pathToFileURL(join(dirname(require.resolve("vitest/package.json")), "dist/index.js")).href;

// Package runtime contract (#4763): exercise the real test script, coordinator and fork.
// Existing runner tests cover temp ownership, not which runtime executes the suite.
for (const name of ["client", "protocol", "server", "telemetry"]) {
	test(`${name} test script runs Vitest and its fork on Bun (#4763)`, { timeout: 90_000 }, () => {
		const fixture = mkdtempSync(join(tmpdir(), "vb-"));
		try {
			// Probe outputs belong to the fixture, not the nested runner's temp parent.
			const temporary = mkdtempSync(join(fixture, "tmp-"));
			const coordinator = join(fixture, "coordinator.json");
			const worker = join(fixture, "worker.json");
			writeFileSync(
				join(fixture, "setup.mjs"),
				`import { writeFileSync } from "node:fs";
export default function () {
	writeFileSync(${JSON.stringify(coordinator)}, JSON.stringify({ bun: process.versions.bun, pid: process.pid }));
}`,
			);
			writeFileSync(
				join(fixture, "vitest.config.mjs"),
				`export default { test: { include: ["probe.test.mjs"], globalSetup: ["./setup.mjs"], pool: "forks" } };`,
			);
			writeFileSync(
				join(fixture, "probe.test.mjs"),
				`import { test, expect } from ${JSON.stringify(vitest)};
import { writeFileSync } from "node:fs";
test("worker runtime", () => {
	writeFileSync(${JSON.stringify(worker)}, JSON.stringify({ bun: process.versions.bun, pid: process.pid }));
	expect(process.versions.bun).toBeDefined();
});`,
			);
			const pm = detectPackageManager();
			const invocation = packageManagerInvocation(
				pm,
				runScriptArguments(pm, "test", [
					"--config",
					join(fixture, "vitest.config.mjs"),
					"--root",
					fixture,
					"--maxWorkers=1",
				]),
			);
			const result = spawnSync(invocation.command, invocation.args, {
				cwd: join(root, "packages", name),
				env: { ...process.env, TMPDIR: temporary, TEMP: temporary, TMP: temporary },
				encoding: "utf8",
				timeout: 60_000,
			});
			assert.equal(result.error, undefined);
			assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
			const main = JSON.parse(readFileSync(coordinator, "utf8"));
			const fork = JSON.parse(readFileSync(worker, "utf8"));
			assert.equal(typeof main.bun, "string", "Vitest coordinator must use Bun");
			assert.equal(typeof fork.bun, "string", "Vitest worker must use Bun");
			assert.notEqual(main.pid, fork.pid, "probe must execute in a separate worker");
		} finally {
			rmSync(fixture, { recursive: true, force: true });
		}
	});
}
