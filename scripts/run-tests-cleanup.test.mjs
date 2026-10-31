#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("cleanup failure reports the child outcome and still runs the leak count (#3064)", () => {
	const parent = mkdtempSync(join(tmpdir(), "senpi-cleanup-error-proof-"));
	let leftover;
	try {
		const preload = join(parent, "busy.cjs");
		writeFileSync(preload, `
			require("node:fs").rmSync = () => { throw Object.assign(new Error("owned root is busy"), { code: "EBUSY" }); };
			require("node:module").syncBuiltinESMExports();
		`);
		const runner = fileURLToPath(new URL("./run-tests.mjs", import.meta.url));
		const result = spawnSync(process.execPath, ["--import", preload, runner, process.execPath, "-e", "process.exit(7)"], {
			env: { ...process.env, TMPDIR: parent, TEMP: parent, TMP: parent, SENPI_TEST_TEMP_GUARD: "1" },
			encoding: "utf8", timeout: 10_000,
		});
		const match = result.stderr.match(/leftover owned root: (".*")/);
		if (match) leftover = JSON.parse(match[1]);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /child exited with 7; cleanup failed/);
		assert.match(result.stderr, /owned root is busy/);
		assert.match(result.stdout, /surviving owned run roots after teardown: 1/);
		assert.match(result.stdout, /new top-level entries after teardown:/);
	} finally {
		if (leftover) rmSync(leftover, { recursive: true, force: true });
		rmSync(parent, { recursive: true, force: true });
	}
});
