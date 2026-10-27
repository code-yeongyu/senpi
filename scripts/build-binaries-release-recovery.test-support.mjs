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

/**
 * A fake `gh` that answers call N with responses[N] (repeating the last one).
 * A response is a stdout line, or `{ stdout, stderr, exit }`; stderr is written before stdout.
 */
export function fakeGhSequence(responses) {
	const gh = fakeBin("gh", "");
	const counter = join(gh.root, "count");
	writeFileSync(counter, "0");
	responses.forEach((response, index) => {
		const { stdout = "", stderr = "", exit = 0 } =
			typeof response === "string" ? { stdout: response } : response;
		const line = (text) => (text ? `${text}\n` : "");
		writeFileSync(join(gh.root, `${index + 1}.out`), line(stdout));
		writeFileSync(join(gh.root, `${index + 1}.err`), line(stderr));
		writeFileSync(join(gh.root, `${index + 1}.code`), String(exit));
	});
	const step = (ext) => JSON.stringify(join(gh.root, `\${n}.${ext}`));
	writeFileSync(
		gh.path,
		`#!/usr/bin/env bash
set -u
echo "$*" >> ${JSON.stringify(join(gh.root, "calls.log"))}
n=$(cat ${JSON.stringify(counter)}); n=$((n + 1)); echo "$n" > ${JSON.stringify(counter)}
if [ "$n" -gt ${responses.length} ]; then n=${responses.length}; fi
cat ${step("err")} >&2
cat ${step("out")}
exit "$(cat ${step("code")})"
`,
	);
	return gh;
}

export function runScript(script, env) {
	return spawnSync("bash", [script], {
		encoding: "utf8",
		env: { ...process.env, ...env },
		timeout: 30_000,
	});
}
