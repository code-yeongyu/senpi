#!/usr/bin/env node

// Fake gh/npm executables for the senpi#4173 release-recovery script tests.

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots = [];

/** Remove every fake created since the last call; register it with afterEach. */
export function cleanupFakes() {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
}

function readCalls(path) {
	try {
		return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

/** An executable `name` whose body runs with $LOG pointing at its call log. */
export function fakeBin(name, body) {
	const root = mkdtempSync(join(tmpdir(), `senpi-4173-${name}-`));
	roots.push(root);
	const path = join(root, name);
	const log = join(root, "calls.log");
	writeFileSync(
		path,
		`#!/usr/bin/env bash\nset -u\nLOG=${JSON.stringify(log)}\n${body}\n`,
	);
	chmodSync(path, 0o755);
	return { path, root, calls: () => readCalls(log) };
}

export function runScript(script, env) {
	return spawnSync("bash", [script], {
		encoding: "utf8",
		env: { ...process.env, ...env },
		timeout: 30_000,
	});
}
